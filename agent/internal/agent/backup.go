package agent

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"

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

func (a *Agent) ProcessBackupVolume(item agenthttp.WorkQueueItem) (json.RawMessage, error) {
	var payload struct {
		BackupID      string        `json:"backupId"`
		ServiceID     string        `json:"serviceId"`
		ContainerID   string        `json:"containerId"`
		VolumeName    string        `json:"volumeName"`
		StoragePath   string        `json:"storagePath"`
		StorageConfig StorageConfig `json:"storageConfig"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return nil, fmt.Errorf("failed to parse backup_volume payload: %w", err)
	}

	size, checksum, err := a.processVolumeBackup(payload.BackupID, payload.ServiceID, payload.ContainerID, payload.VolumeName, payload.StoragePath, payload.StorageConfig)
	if err != nil {
		return nil, err
	}

	output, err := json.Marshal(map[string]interface{}{
		"sizeBytes": size,
		"checksum":  checksum,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal backup output: %w", err)
	}

	return output, nil
}

func (a *Agent) processVolumeBackup(backupID, serviceID, containerID, volumeName, storagePath string, storageConfig StorageConfig) (int64, string, error) {
	volumePath := filepath.Join(a.DataDir, "volumes", serviceID, volumeName)
	log.Printf("[backup_volume] backing up volume %s from %s", volumeName, volumePath)

	if !strings.HasSuffix(storagePath, ".tar.gz") {
		return 0, "", fmt.Errorf("unsupported backup archive path: %s", storagePath)
	}

	if _, err := os.Stat(volumePath); os.IsNotExist(err) {
		return 0, "", fmt.Errorf("volume path does not exist: %s", volumePath)
	}

	if containerID != "" {
		running, err := container.IsContainerRunning(containerID)
		if err != nil {
			return 0, "", fmt.Errorf("failed to check container status: %w", err)
		}

		if running {
			log.Printf("[backup_volume] stopping container %s before backup", Truncate(containerID, 12))
			if err := container.Stop(containerID); err != nil {
				return 0, "", fmt.Errorf("failed to stop container: %w", err)
			}

			defer func() {
				log.Printf("[backup_volume] starting container %s after backup", Truncate(containerID, 12))
				err := retry.WithBackoff(context.Background(), retry.UnpauseBackoff, func() (bool, error) {
					if err := container.Start(containerID); err != nil {
						log.Printf("[backup_volume] start attempt failed for container %s: %v", Truncate(containerID, 12), err)
						return false, err
					}
					return true, nil
				})
				if err != nil {
					log.Printf("[backup_volume] CRITICAL: failed to start container %s after backup: %v", Truncate(containerID, 12), err)
				}
			}()
		} else {
			log.Printf("[backup_volume] container %s not running; skipping stop", Truncate(containerID, 12))
		}
	}

	tarPath, err := tempArtifactPath(a.DataDir, fmt.Sprintf("backup-%s.tar.gz", backupID))
	if err != nil {
		return 0, "", fmt.Errorf("failed to create temp archive path: %w", err)
	}
	defer os.Remove(tarPath)

	size, checksum, err := createTarGzWithChecksum(volumePath, tarPath)
	if err != nil {
		return 0, "", fmt.Errorf("failed to create archive: %w", err)
	}

	log.Printf("[backup_volume] created archive: size=%d, checksum=%s", size, checksum)

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return 0, "", fmt.Errorf("failed to create S3 client: %w", err)
	}

	if err := uploadToS3(s3Client, storageConfig.Bucket, storagePath, tarPath); err != nil {
		return 0, "", fmt.Errorf("failed to upload to S3: %w", err)
	}

	log.Printf("[backup_volume] uploaded to S3: %s/%s", storageConfig.Bucket, storagePath)

	return size, checksum, nil
}

func (a *Agent) ProcessRestoreVolume(item agenthttp.WorkQueueItem) error {
	var payload struct {
		BackupID         string        `json:"backupId"`
		ServiceID        string        `json:"serviceId"`
		ContainerID      string        `json:"containerId"`
		VolumeName       string        `json:"volumeName"`
		StoragePath      string        `json:"storagePath"`
		ExpectedChecksum string        `json:"expectedChecksum"`
		StorageConfig    StorageConfig `json:"storageConfig"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse restore_volume payload: %w", err)
	}

	return a.processVolumeRestore(payload.BackupID, payload.ServiceID, payload.ContainerID, payload.VolumeName, payload.StoragePath, payload.ExpectedChecksum, payload.StorageConfig)
}

func (a *Agent) processVolumeRestore(backupID, serviceID, containerID, volumeName, storagePath, expectedChecksum string, storageConfig StorageConfig) error {
	volumePath := filepath.Join(a.DataDir, "volumes", serviceID, volumeName)
	log.Printf("[restore_volume] restoring volume %s to %s", volumeName, volumePath)

	tarPath, err := tempArtifactPath(a.DataDir, fmt.Sprintf("restore-%s.tar.gz", backupID))
	if err != nil {
		return fmt.Errorf("failed to create temp archive path: %w", err)
	}
	defer os.Remove(tarPath)

	if !strings.HasSuffix(storagePath, ".tar.gz") {
		return fmt.Errorf("unsupported backup archive path: %s", storagePath)
	}

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return fmt.Errorf("failed to create S3 client: %w", err)
	}

	if err := downloadFromS3(s3Client, storageConfig.Bucket, storagePath, tarPath); err != nil {
		return fmt.Errorf("failed to download from S3: %w", err)
	}

	log.Printf("[restore_volume] downloaded from S3: %s/%s", storageConfig.Bucket, storagePath)

	checksum, err := calculateChecksum(tarPath)
	if err != nil {
		return fmt.Errorf("failed to calculate checksum: %w", err)
	}

	if checksum != expectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, checksum)
	}

	tempExtractPath, err := tempArtifactPath(a.DataDir, fmt.Sprintf("restore-extract-%s", backupID))
	if err != nil {
		return fmt.Errorf("failed to create temp extract path: %w", err)
	}
	defer os.RemoveAll(tempExtractPath)

	if err := os.MkdirAll(tempExtractPath, 0755); err != nil {
		return fmt.Errorf("failed to create temp extract directory: %w", err)
	}

	log.Printf("[restore_volume] extracting archive to temp location for validation")
	if err := extractTarGz(tarPath, tempExtractPath); err != nil {
		return fmt.Errorf("failed to extract archive: %w", err)
	}

	var shouldStartContainer bool
	if containerID != "" {
		running, err := container.IsContainerRunning(containerID)
		if err != nil {
			log.Printf("[restore_volume] failed to check container status: %v, proceeding without stop", err)
		} else if running {
			log.Printf("[restore_volume] stopping container %s before restore", Truncate(containerID, 12))
			if err := container.Stop(containerID); err != nil {
				return fmt.Errorf("failed to stop container: %w", err)
			}
			shouldStartContainer = true
		} else {
			log.Printf("[restore_volume] container %s not running; skipping stop", Truncate(containerID, 12))
		}
	} else {
		log.Printf("[restore_volume] no containerID provided, restoring directly to volume path")
	}

	startContainerWithRetry := func() {
		if !shouldStartContainer {
			return
		}
		log.Printf("[restore_volume] starting container %s", Truncate(containerID, 12))
		err := retry.WithBackoff(context.Background(), retry.UnpauseBackoff, func() (bool, error) {
			if err := container.Start(containerID); err != nil {
				log.Printf("[restore_volume] start attempt failed for container %s: %v", Truncate(containerID, 12), err)
				return false, err
			}
			return true, nil
		})
		if err != nil {
			log.Printf("[restore_volume] CRITICAL: failed to start container %s: %v", Truncate(containerID, 12), err)
		}
	}

	if err := os.RemoveAll(volumePath); err != nil && !os.IsNotExist(err) {
		startContainerWithRetry()
		return fmt.Errorf("failed to remove existing volume: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(volumePath), 0755); err != nil {
		startContainerWithRetry()
		return fmt.Errorf("failed to create volume parent directory: %w", err)
	}

	if err := moveDir(tempExtractPath, volumePath); err != nil {
		startContainerWithRetry()
		return fmt.Errorf("failed to move restored data to volume path: %w", err)
	}

	startContainerWithRetry()

	log.Printf("[restore_volume] restored volume %s successfully", volumeName)

	return nil
}

func tempArtifactPath(dataDir, name string) (string, error) {
	if name == "" || name != filepath.Base(name) {
		return "", fmt.Errorf("invalid temp artifact name: %s", name)
	}

	tmpDir := filepath.Join(dataDir, "tmp")
	if err := os.MkdirAll(tmpDir, 0700); err != nil {
		return "", err
	}

	return filepath.Join(tmpDir, name), nil
}

func moveDir(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	} else if !errors.Is(err, syscall.EXDEV) {
		return err
	}

	if err := copyDir(src, dst); err != nil {
		return err
	}

	return os.RemoveAll(src)
}

func copyDir(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("source is not a directory: %s", src)
	}

	if err := os.MkdirAll(dst, info.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())
		entryInfo, err := os.Lstat(srcPath)
		if err != nil {
			return err
		}

		if entryInfo.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
			continue
		}

		if entryInfo.Mode()&os.ModeSymlink != 0 {
			linkTarget, err := os.Readlink(srcPath)
			if err != nil {
				return err
			}
			if err := os.Symlink(linkTarget, dstPath); err != nil {
				return err
			}
			continue
		}

		if !entryInfo.Mode().IsRegular() {
			return fmt.Errorf("unsupported file type in restore archive: %s", srcPath)
		}

		if err := copyFile(srcPath, dstPath, entryInfo.Mode()); err != nil {
			return err
		}
	}

	return os.Chmod(dst, info.Mode())
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}

	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
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

		parentDir := filepath.Dir(targetPath)
		if resolvedParent, err := filepath.EvalSymlinks(parentDir); err == nil {
			if !strings.HasPrefix(resolvedParent, filepath.Clean(destPath)+string(os.PathSeparator)) &&
				resolvedParent != filepath.Clean(destPath) {
				return fmt.Errorf("invalid tar entry (symlink traversal): %s", header.Name)
			}
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
			linkTarget := header.Linkname
			if !filepath.IsAbs(linkTarget) {
				linkTarget = filepath.Join(filepath.Dir(targetPath), linkTarget)
			}
			resolvedLink := filepath.Clean(linkTarget)
			if !strings.HasPrefix(resolvedLink, filepath.Clean(destPath)+string(os.PathSeparator)) &&
				resolvedLink != filepath.Clean(destPath) {
				return fmt.Errorf("invalid symlink target: %s -> %s", header.Name, header.Linkname)
			}
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
