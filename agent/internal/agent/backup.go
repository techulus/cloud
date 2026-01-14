package agent

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"techulus/cloud-agent/internal/container"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/retry"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type StorageConfig struct {
	Provider  string `json:"provider"`
	Bucket    string `json:"bucket"`
	Region    string `json:"region"`
	Endpoint  string `json:"endpoint"`
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

func (a *Agent) ProcessBackupVolume(item agenthttp.WorkQueueItem) error {
	var payload struct {
		BackupID      string        `json:"backupId"`
		ServiceID     string        `json:"serviceId"`
		ContainerID   string        `json:"containerId"`
		VolumeName    string        `json:"volumeName"`
		StoragePath   string        `json:"storagePath"`
		StorageConfig StorageConfig `json:"storageConfig"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse backup_volume payload: %w", err)
	}

	volumePath := filepath.Join(a.DataDir, "volumes", payload.ServiceID, payload.VolumeName)
	log.Printf("[backup_volume] backing up volume %s from %s", payload.VolumeName, volumePath)

	if _, err := os.Stat(volumePath); os.IsNotExist(err) {
		return fmt.Errorf("volume path does not exist: %s", volumePath)
	}

	if payload.ContainerID != "" {
		running, err := container.IsContainerRunning(payload.ContainerID)
		if err != nil {
			return fmt.Errorf("failed to check container status: %w", err)
		}

		if running {
			log.Printf("[backup_volume] pausing container %s", Truncate(payload.ContainerID, 12))
			if err := container.Pause(payload.ContainerID); err != nil {
				return fmt.Errorf("failed to pause container: %w", err)
			}

			defer func() {
				log.Printf("[backup_volume] resuming container %s", Truncate(payload.ContainerID, 12))
				err := retry.WithBackoff(context.Background(), retry.UnpauseBackoff, func() (bool, error) {
					if err := container.Unpause(payload.ContainerID); err != nil {
						log.Printf("[backup_volume] unpause attempt failed for container %s: %v", Truncate(payload.ContainerID, 12), err)
						return false, err
					}
					return true, nil
				})
				if err != nil {
					log.Printf("[backup_volume] CRITICAL: failed to resume container %s: %v", Truncate(payload.ContainerID, 12), err)
				}
			}()
		} else {
			log.Printf("[backup_volume] container %s not running; skipping pause", Truncate(payload.ContainerID, 12))
		}
	}

	tarPath := filepath.Join(os.TempDir(), fmt.Sprintf("backup-%s.tar.gz", payload.BackupID))
	defer os.Remove(tarPath)

	size, checksum, err := createTarGzWithChecksum(volumePath, tarPath)
	if err != nil {
		return fmt.Errorf("failed to create archive: %w", err)
	}

	log.Printf("[backup_volume] created archive: size=%d, checksum=%s", size, checksum)

	s3Client, err := createS3Client(payload.StorageConfig)
	if err != nil {
		return fmt.Errorf("failed to create S3 client: %w", err)
	}

	if err := uploadToS3(s3Client, payload.StorageConfig.Bucket, payload.StoragePath, tarPath); err != nil {
		return fmt.Errorf("failed to upload to S3: %w", err)
	}

	log.Printf("[backup_volume] uploaded to S3: %s/%s", payload.StorageConfig.Bucket, payload.StoragePath)

	if err := a.Client.ReportBackupComplete(payload.BackupID, size, checksum); err != nil {
		return fmt.Errorf("failed to report backup complete: %w", err)
	}

	return nil
}

func (a *Agent) ProcessRestoreVolume(item agenthttp.WorkQueueItem) error {
	var payload struct {
		BackupID         string        `json:"backupId"`
		ServiceID        string        `json:"serviceId"`
		VolumeName       string        `json:"volumeName"`
		StoragePath      string        `json:"storagePath"`
		ExpectedChecksum string        `json:"expectedChecksum"`
		StorageConfig    StorageConfig `json:"storageConfig"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse restore_volume payload: %w", err)
	}

	volumePath := filepath.Join(a.DataDir, "volumes", payload.ServiceID, payload.VolumeName)
	log.Printf("[restore_volume] restoring volume %s to %s", payload.VolumeName, volumePath)

	tarPath := filepath.Join(os.TempDir(), fmt.Sprintf("restore-%s.tar.gz", payload.BackupID))
	defer os.Remove(tarPath)

	s3Client, err := createS3Client(payload.StorageConfig)
	if err != nil {
		return fmt.Errorf("failed to create S3 client: %w", err)
	}

	if err := downloadFromS3(s3Client, payload.StorageConfig.Bucket, payload.StoragePath, tarPath); err != nil {
		return fmt.Errorf("failed to download from S3: %w", err)
	}

	log.Printf("[restore_volume] downloaded from S3: %s/%s", payload.StorageConfig.Bucket, payload.StoragePath)

	checksum, err := calculateChecksum(tarPath)
	if err != nil {
		return fmt.Errorf("failed to calculate checksum: %w", err)
	}

	if checksum != payload.ExpectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", payload.ExpectedChecksum, checksum)
	}

	if err := os.RemoveAll(volumePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove existing volume: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(volumePath), 0755); err != nil {
		return fmt.Errorf("failed to create volume parent directory: %w", err)
	}

	if err := extractTarGz(tarPath, volumePath); err != nil {
		return fmt.Errorf("failed to extract archive: %w", err)
	}

	log.Printf("[restore_volume] restored volume %s successfully", payload.VolumeName)

	return nil
}

func createS3Client(cfg StorageConfig) (*s3.Client, error) {
	awsCfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion(cfg.Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			cfg.AccessKey,
			cfg.SecretKey,
			"",
		)),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
			o.UsePathStyle = true
		}
	})

	return client, nil
}

func uploadToS3(client *s3.Client, bucket, key, filePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	_, err = client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   file,
	})
	if err != nil {
		return fmt.Errorf("failed to upload object: %w", err)
	}

	return nil
}

func downloadFromS3(client *s3.Client, bucket, key, filePath string) error {
	result, err := client.GetObject(context.Background(), &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("failed to get object: %w", err)
	}
	defer result.Body.Close()

	file, err := os.Create(filePath)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer file.Close()

	if _, err := io.Copy(file, result.Body); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}

func createTarGzWithChecksum(sourcePath, destPath string) (int64, string, error) {
	destFile, err := os.Create(destPath)
	if err != nil {
		return 0, "", fmt.Errorf("failed to create destination file: %w", err)
	}
	defer destFile.Close()

	hash := sha256.New()
	multiWriter := io.MultiWriter(destFile, hash)

	gzipWriter := gzip.NewWriter(multiWriter)
	defer gzipWriter.Close()

	tarWriter := tar.NewWriter(gzipWriter)
	defer tarWriter.Close()

	err = filepath.Walk(sourcePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(sourcePath, path)
		if err != nil {
			return err
		}

		if relPath == "." {
			return nil
		}

		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = relPath

		if info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			header.Linkname = link
		}

		if err := tarWriter.WriteHeader(header); err != nil {
			return err
		}

		if !info.Mode().IsRegular() {
			return nil
		}

		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()

		if _, err := io.Copy(tarWriter, file); err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return 0, "", fmt.Errorf("failed to walk source directory: %w", err)
	}

	tarWriter.Close()
	gzipWriter.Close()

	stat, err := os.Stat(destPath)
	if err != nil {
		return 0, "", fmt.Errorf("failed to stat archive: %w", err)
	}

	return stat.Size(), hex.EncodeToString(hash.Sum(nil)), nil
}

func extractTarGz(archivePath, destPath string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("failed to open archive: %w", err)
	}
	defer file.Close()

	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzipReader.Close()

	tarReader := tar.NewReader(gzipReader)

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read tar header: %w", err)
		}

		targetPath := filepath.Join(destPath, header.Name)

		if !strings.HasPrefix(targetPath, filepath.Clean(destPath)+string(os.PathSeparator)) {
			return fmt.Errorf("invalid tar entry: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetPath, os.FileMode(header.Mode)); err != nil {
				return fmt.Errorf("failed to create directory: %w", err)
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				return fmt.Errorf("failed to create parent directory: %w", err)
			}
			outFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode))
			if err != nil {
				return fmt.Errorf("failed to create file: %w", err)
			}
			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return fmt.Errorf("failed to write file: %w", err)
			}
			outFile.Close()
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				return fmt.Errorf("failed to create parent directory: %w", err)
			}
			if err := os.Symlink(header.Linkname, targetPath); err != nil {
				return fmt.Errorf("failed to create symlink: %w", err)
			}
		}
	}

	return nil
}

func calculateChecksum(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", fmt.Errorf("failed to calculate hash: %w", err)
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}
