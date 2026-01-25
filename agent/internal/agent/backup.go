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
	"time"

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

func detectDatabaseType(image string) string {
	image = strings.ToLower(image)
	switch {
	case strings.Contains(image, "postgres"):
		return "postgres"
	case strings.Contains(image, "mysql"):
		return "mysql"
	case strings.Contains(image, "mariadb"):
		return "mariadb"
	case strings.Contains(image, "mongo"):
		return "mongodb"
	case strings.Contains(image, "redis"):
		return "redis"
	default:
		return ""
	}
}

func getDatabaseBackupCommand(dbType string) []string {
	switch dbType {
	case "postgres":
		return []string{"sh", "-c", "pg_dump -Fc --no-acl --no-owner -U ${POSTGRES_USER:-postgres} ${POSTGRES_DB:-postgres}"}
	case "mysql":
		return []string{"sh", "-c", "mysqldump -u root -p$MYSQL_ROOT_PASSWORD --all-databases --single-transaction"}
	case "mariadb":
		return []string{"sh", "-c", "mariadb-dump -u root -p$MARIADB_ROOT_PASSWORD --all-databases --single-transaction"}
	case "mongodb":
		return []string{"sh", "-c", "mongodump --username=$MONGO_INITDB_ROOT_USERNAME --password=$MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase=admin --archive --gzip"}
	case "redis":
		return []string{"redis-cli", "BGSAVE"}
	default:
		return nil
	}
}

func getDatabaseRestoreCommand(dbType string) []string {
	switch dbType {
	case "postgres":
		return []string{"sh", "-c", "pg_restore -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-postgres} --clean --if-exists"}
	case "mysql":
		return []string{"sh", "-c", "mysql -u root -p$MYSQL_ROOT_PASSWORD"}
	case "mariadb":
		return []string{"sh", "-c", "mariadb -u root -p$MARIADB_ROOT_PASSWORD"}
	case "mongodb":
		return []string{"sh", "-c", "mongorestore --username=$MONGO_INITDB_ROOT_USERNAME --password=$MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase=admin --archive --gzip"}
	default:
		return nil
	}
}

func getBackupFileExtension(dbType string) string {
	switch dbType {
	case "postgres":
		return ".dump"
	case "mysql", "mariadb":
		return ".sql"
	case "mongodb":
		return ".archive.gz"
	case "redis":
		return ".rdb"
	default:
		return ".backup"
	}
}

var credentialErrors = map[string]string{
	"postgres": "PostgreSQL backup failed. Ensure POSTGRES_USER and POSTGRES_PASSWORD env vars are set, or that local trust authentication is enabled.",
	"mysql":    "MySQL backup failed. Ensure MYSQL_ROOT_PASSWORD env var is set in your container.",
	"mariadb":  "MariaDB backup failed. Ensure MARIADB_ROOT_PASSWORD or MYSQL_ROOT_PASSWORD env var is set.",
	"mongodb":  "MongoDB backup failed. Ensure MONGO_INITDB_ROOT_USERNAME and MONGO_INITDB_ROOT_PASSWORD env vars are set, or that auth is disabled.",
	"redis":    "Redis backup failed.",
}

func isAuthError(output string) bool {
	authPatterns := []string{
		"password authentication failed",
		"Access denied",
		"authentication failed",
		"NOAUTH",
		"auth failed",
	}
	outputLower := strings.ToLower(output)
	for _, pattern := range authPatterns {
		if strings.Contains(outputLower, strings.ToLower(pattern)) {
			return true
		}
	}
	return false
}

func (a *Agent) ProcessBackupVolume(item agenthttp.WorkQueueItem) error {
	var payload struct {
		BackupID      string        `json:"backupId"`
		ServiceID     string        `json:"serviceId"`
		ContainerID   string        `json:"containerId"`
		VolumeName    string        `json:"volumeName"`
		StoragePath   string        `json:"storagePath"`
		StorageConfig StorageConfig `json:"storageConfig"`
		BackupType    string        `json:"backupType"`
		ServiceImage  string        `json:"serviceImage"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse backup_volume payload: %w", err)
	}

	if payload.BackupType == "database" {
		return a.processDatabaseBackup(payload.BackupID, payload.ServiceID, payload.ContainerID, payload.ServiceImage, payload.StoragePath, payload.StorageConfig)
	}

	return a.processVolumeBackup(payload.BackupID, payload.ServiceID, payload.ContainerID, payload.VolumeName, payload.StoragePath, payload.StorageConfig)
}

func (a *Agent) processVolumeBackup(backupID, serviceID, containerID, volumeName, storagePath string, storageConfig StorageConfig) error {
	volumePath := filepath.Join(a.DataDir, "volumes", serviceID, volumeName)
	log.Printf("[backup_volume] backing up volume %s from %s", volumeName, volumePath)

	if _, err := os.Stat(volumePath); os.IsNotExist(err) {
		return fmt.Errorf("volume path does not exist: %s", volumePath)
	}

	if containerID != "" {
		running, err := container.IsContainerRunning(containerID)
		if err != nil {
			return fmt.Errorf("failed to check container status: %w", err)
		}

		if running {
			log.Printf("[backup_volume] pausing container %s", Truncate(containerID, 12))
			if err := container.Pause(containerID); err != nil {
				return fmt.Errorf("failed to pause container: %w", err)
			}

			defer func() {
				log.Printf("[backup_volume] resuming container %s", Truncate(containerID, 12))
				err := retry.WithBackoff(context.Background(), retry.UnpauseBackoff, func() (bool, error) {
					if err := container.Unpause(containerID); err != nil {
						log.Printf("[backup_volume] unpause attempt failed for container %s: %v", Truncate(containerID, 12), err)
						return false, err
					}
					return true, nil
				})
				if err != nil {
					log.Printf("[backup_volume] CRITICAL: failed to resume container %s: %v", Truncate(containerID, 12), err)
				}
			}()
		} else {
			log.Printf("[backup_volume] container %s not running; skipping pause", Truncate(containerID, 12))
		}
	}

	tarPath := filepath.Join(os.TempDir(), fmt.Sprintf("backup-%s.tar.gz", backupID))
	defer os.Remove(tarPath)

	size, checksum, err := createTarGzWithChecksum(volumePath, tarPath)
	if err != nil {
		return fmt.Errorf("failed to create archive: %w", err)
	}

	log.Printf("[backup_volume] created archive: size=%d, checksum=%s", size, checksum)

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return fmt.Errorf("failed to create S3 client: %w", err)
	}

	if err := uploadToS3(s3Client, storageConfig.Bucket, storagePath, tarPath); err != nil {
		return fmt.Errorf("failed to upload to S3: %w", err)
	}

	log.Printf("[backup_volume] uploaded to S3: %s/%s", storageConfig.Bucket, storagePath)

	if err := a.Client.ReportBackupComplete(backupID, size, checksum); err != nil {
		return fmt.Errorf("failed to report backup complete: %w", err)
	}

	return nil
}

func (a *Agent) processDatabaseBackup(backupID, serviceID, containerID, serviceImage, storagePath string, storageConfig StorageConfig) error {
	dbType := detectDatabaseType(serviceImage)
	if dbType == "" {
		log.Printf("[backup_database] unknown database type for image %s, falling back to volume backup", serviceImage)
		return fmt.Errorf("database backup not supported for image: %s", serviceImage)
	}

	log.Printf("[backup_database] detected database type: %s for image %s", dbType, serviceImage)

	if containerID == "" {
		return fmt.Errorf("containerId is required for database backup")
	}

	running, err := container.IsContainerRunning(containerID)
	if err != nil {
		return fmt.Errorf("failed to check container status: %w", err)
	}
	if !running {
		return fmt.Errorf("container %s is not running", containerID)
	}

	if dbType == "redis" {
		return a.processRedisBackup(backupID, serviceID, containerID, storagePath, storageConfig)
	}

	cmd := getDatabaseBackupCommand(dbType)
	if cmd == nil {
		return fmt.Errorf("no backup command for database type: %s", dbType)
	}

	log.Printf("[backup_database] executing backup command in container %s", Truncate(containerID, 12))

	output, err := container.Exec(containerID, cmd)
	if err != nil {
		outputStr := string(output)
		if isAuthError(outputStr) {
			if errMsg, ok := credentialErrors[dbType]; ok {
				return fmt.Errorf("%s\n\nOriginal error: %s", errMsg, outputStr)
			}
		}
		return fmt.Errorf("database backup failed: %s: %w", outputStr, err)
	}

	backupPath := filepath.Join(os.TempDir(), fmt.Sprintf("dbbackup-%s%s", backupID, getBackupFileExtension(dbType)))
	defer os.Remove(backupPath)

	if err := os.WriteFile(backupPath, output, 0600); err != nil {
		return fmt.Errorf("failed to write backup file: %w", err)
	}

	stat, err := os.Stat(backupPath)
	if err != nil {
		return fmt.Errorf("failed to stat backup file: %w", err)
	}

	checksum, err := calculateChecksum(backupPath)
	if err != nil {
		return fmt.Errorf("failed to calculate checksum: %w", err)
	}

	size := stat.Size()

	log.Printf("[backup_database] created backup: size=%d, checksum=%s", size, checksum)

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return fmt.Errorf("failed to create S3 client: %w", err)
	}

	if err := uploadToS3(s3Client, storageConfig.Bucket, storagePath, backupPath); err != nil {
		return fmt.Errorf("failed to upload to S3: %w", err)
	}

	log.Printf("[backup_database] uploaded to S3: %s/%s", storageConfig.Bucket, storagePath)

	if err := a.Client.ReportBackupComplete(backupID, size, checksum); err != nil {
		return fmt.Errorf("failed to report backup complete: %w", err)
	}

	return nil
}

func (a *Agent) processRedisBackup(backupID, serviceID, containerID, storagePath string, storageConfig StorageConfig) error {
	log.Printf("[backup_database] getting Redis dump path from container %s", Truncate(containerID, 12))

	rdbPath, err := getRedisRDBPath(containerID)
	if err != nil {
		return fmt.Errorf("failed to get Redis RDB path: %w", err)
	}

	lastSaveOutput, err := container.Exec(containerID, []string{"redis-cli", "LASTSAVE"})
	if err != nil {
		return fmt.Errorf("failed to get LASTSAVE: %w", err)
	}
	lastSaveBefore := strings.TrimSpace(string(lastSaveOutput))

	log.Printf("[backup_database] triggering Redis BGSAVE in container %s", Truncate(containerID, 12))

	output, err := container.Exec(containerID, []string{"redis-cli", "BGSAVE"})
	if err != nil {
		return fmt.Errorf("redis BGSAVE failed: %s: %w", string(output), err)
	}

	log.Printf("[backup_database] waiting for BGSAVE to complete")
	for i := 0; i < 60; i++ {
		time.Sleep(time.Second)
		lastSaveOutput, err := container.Exec(containerID, []string{"redis-cli", "LASTSAVE"})
		if err != nil {
			continue
		}
		lastSaveAfter := strings.TrimSpace(string(lastSaveOutput))
		if lastSaveAfter != lastSaveBefore {
			log.Printf("[backup_database] BGSAVE completed")
			break
		}
		if i == 59 {
			return fmt.Errorf("BGSAVE did not complete within 60 seconds")
		}
	}

	log.Printf("[backup_database] copying %s from container", rdbPath)

	rdbOutput, err := container.Exec(containerID, []string{"cat", rdbPath})
	if err != nil {
		return fmt.Errorf("failed to read Redis dump file: %s: %w", string(rdbOutput), err)
	}

	backupPath := filepath.Join(os.TempDir(), fmt.Sprintf("dbbackup-%s.rdb", backupID))
	defer os.Remove(backupPath)

	if err := os.WriteFile(backupPath, rdbOutput, 0600); err != nil {
		return fmt.Errorf("failed to write backup file: %w", err)
	}

	stat, err := os.Stat(backupPath)
	if err != nil {
		return fmt.Errorf("failed to stat backup file: %w", err)
	}

	checksum, err := calculateChecksum(backupPath)
	if err != nil {
		return fmt.Errorf("failed to calculate checksum: %w", err)
	}

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return fmt.Errorf("failed to create S3 client: %w", err)
	}

	if err := uploadToS3(s3Client, storageConfig.Bucket, storagePath, backupPath); err != nil {
		return fmt.Errorf("failed to upload to S3: %w", err)
	}

	log.Printf("[backup_database] uploaded to S3: %s/%s", storageConfig.Bucket, storagePath)

	if err := a.Client.ReportBackupComplete(backupID, stat.Size(), checksum); err != nil {
		return fmt.Errorf("failed to report backup complete: %w", err)
	}

	return nil
}

func getRedisRDBPath(containerID string) (string, error) {
	dirOutput, err := container.Exec(containerID, []string{"redis-cli", "CONFIG", "GET", "dir"})
	if err != nil {
		return "/data/dump.rdb", nil
	}
	dirParts := strings.Split(strings.TrimSpace(string(dirOutput)), "\n")
	dir := "/data"
	if len(dirParts) >= 2 {
		dir = strings.TrimSpace(dirParts[1])
	}

	fileOutput, err := container.Exec(containerID, []string{"redis-cli", "CONFIG", "GET", "dbfilename"})
	if err != nil {
		return filepath.Join(dir, "dump.rdb"), nil
	}
	fileParts := strings.Split(strings.TrimSpace(string(fileOutput)), "\n")
	filename := "dump.rdb"
	if len(fileParts) >= 2 {
		filename = strings.TrimSpace(fileParts[1])
	}

	return filepath.Join(dir, filename), nil
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
		BackupType       string        `json:"backupType"`
		ServiceImage     string        `json:"serviceImage"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse restore_volume payload: %w", err)
	}

	if payload.BackupType == "database" {
		return a.processDatabaseRestore(payload.BackupID, payload.ServiceID, payload.ContainerID, payload.ServiceImage, payload.StoragePath, payload.ExpectedChecksum, payload.StorageConfig)
	}

	return a.processVolumeRestore(payload.BackupID, payload.ServiceID, payload.ContainerID, payload.VolumeName, payload.StoragePath, payload.ExpectedChecksum, payload.StorageConfig)
}

func (a *Agent) processVolumeRestore(backupID, serviceID, containerID, volumeName, storagePath, expectedChecksum string, storageConfig StorageConfig) error {
	volumePath := filepath.Join(a.DataDir, "volumes", serviceID, volumeName)
	log.Printf("[restore_volume] restoring volume %s to %s", volumeName, volumePath)

	reportFailure := func(err error) error {
		if reportErr := a.Client.ReportRestoreComplete(backupID, false, err.Error()); reportErr != nil {
			log.Printf("[restore_volume] warning: failed to report restore failure: %v", reportErr)
		}
		return err
	}

	if containerID != "" {
		running, err := container.IsContainerRunning(containerID)
		if err != nil {
			log.Printf("[restore_volume] failed to check container status: %v, proceeding without stop", err)
		} else if running {
			log.Printf("[restore_volume] stopping container %s before restore", Truncate(containerID, 12))
			if err := container.Stop(containerID); err != nil {
				return reportFailure(fmt.Errorf("failed to stop container: %w", err))
			}

			defer func() {
				log.Printf("[restore_volume] starting container %s after restore", Truncate(containerID, 12))
				if err := container.Start(containerID); err != nil {
					log.Printf("[restore_volume] CRITICAL: failed to start container %s: %v", Truncate(containerID, 12), err)
				}
			}()
		} else {
			log.Printf("[restore_volume] container %s not running; skipping stop", Truncate(containerID, 12))
		}
	} else {
		log.Printf("[restore_volume] no containerID provided, restoring directly to volume path")
	}

	tarPath := filepath.Join(os.TempDir(), fmt.Sprintf("restore-%s.tar.gz", backupID))
	defer os.Remove(tarPath)

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to create S3 client: %w", err))
	}

	if err := downloadFromS3(s3Client, storageConfig.Bucket, storagePath, tarPath); err != nil {
		return reportFailure(fmt.Errorf("failed to download from S3: %w", err))
	}

	log.Printf("[restore_volume] downloaded from S3: %s/%s", storageConfig.Bucket, storagePath)

	checksum, err := calculateChecksum(tarPath)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to calculate checksum: %w", err))
	}

	if checksum != expectedChecksum {
		return reportFailure(fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, checksum))
	}

	if err := os.RemoveAll(volumePath); err != nil && !os.IsNotExist(err) {
		return reportFailure(fmt.Errorf("failed to remove existing volume: %w", err))
	}

	if err := os.MkdirAll(filepath.Dir(volumePath), 0755); err != nil {
		return reportFailure(fmt.Errorf("failed to create volume parent directory: %w", err))
	}

	if err := extractTarGz(tarPath, volumePath); err != nil {
		return reportFailure(fmt.Errorf("failed to extract archive: %w", err))
	}

	log.Printf("[restore_volume] restored volume %s successfully", volumeName)

	if err := a.Client.ReportRestoreComplete(backupID, true, ""); err != nil {
		log.Printf("[restore_volume] warning: failed to report restore complete: %v", err)
	}

	return nil
}

func (a *Agent) processDatabaseRestore(backupID, serviceID, containerID, serviceImage, storagePath, expectedChecksum string, storageConfig StorageConfig) error {
	dbType := detectDatabaseType(serviceImage)
	if dbType == "" {
		return fmt.Errorf("database restore not supported for image: %s", serviceImage)
	}

	log.Printf("[restore_database] detected database type: %s for image %s", dbType, serviceImage)

	reportFailure := func(err error) error {
		if reportErr := a.Client.ReportRestoreComplete(backupID, false, err.Error()); reportErr != nil {
			log.Printf("[restore_database] warning: failed to report restore failure: %v", reportErr)
		}
		return err
	}

	if dbType == "redis" && containerID == "" {
		return a.processRedisRestoreToVolume(backupID, serviceID, storagePath, expectedChecksum, storageConfig)
	}

	if containerID == "" {
		return reportFailure(fmt.Errorf("containerId is required for %s database restore", dbType))
	}

	running, err := container.IsContainerRunning(containerID)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to check container status: %w", err))
	}
	if !running {
		return reportFailure(fmt.Errorf("container %s is not running", containerID))
	}

	restorePath := filepath.Join(os.TempDir(), fmt.Sprintf("dbrestore-%s%s", backupID, getBackupFileExtension(dbType)))
	defer os.Remove(restorePath)

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to create S3 client: %w", err))
	}

	if err := downloadFromS3(s3Client, storageConfig.Bucket, storagePath, restorePath); err != nil {
		return reportFailure(fmt.Errorf("failed to download from S3: %w", err))
	}

	log.Printf("[restore_database] downloaded from S3: %s/%s", storageConfig.Bucket, storagePath)

	checksum, err := calculateChecksum(restorePath)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to calculate checksum: %w", err))
	}

	if checksum != expectedChecksum {
		return reportFailure(fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, checksum))
	}

	if dbType == "redis" {
		return a.processRedisRestore(backupID, containerID, restorePath)
	}

	log.Printf("[restore_database] copying backup file to container %s", Truncate(containerID, 12))

	containerRestorePath := fmt.Sprintf("/tmp/restore%s", getBackupFileExtension(dbType))
	if err := copyFileToContainer(containerID, restorePath, containerRestorePath); err != nil {
		return reportFailure(fmt.Errorf("failed to copy backup to container: %w", err))
	}

	defer container.Exec(containerID, []string{"rm", "-f", containerRestorePath})

	log.Printf("[restore_database] executing restore command in container %s", Truncate(containerID, 12))

	var restoreCmd []string
	switch dbType {
	case "postgres":
		restoreCmd = []string{"sh", "-c", fmt.Sprintf("pg_restore -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-postgres} --clean --if-exists %s", containerRestorePath)}
	case "mysql":
		restoreCmd = []string{"sh", "-c", fmt.Sprintf("mysql -u root -p$MYSQL_ROOT_PASSWORD < %s", containerRestorePath)}
	case "mariadb":
		restoreCmd = []string{"sh", "-c", fmt.Sprintf("mariadb -u root -p$MARIADB_ROOT_PASSWORD < %s", containerRestorePath)}
	case "mongodb":
		restoreCmd = []string{"sh", "-c", fmt.Sprintf("mongorestore --username=$MONGO_INITDB_ROOT_USERNAME --password=$MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase=admin --archive=%s --gzip", containerRestorePath)}
	default:
		return reportFailure(fmt.Errorf("unsupported database type for restore: %s", dbType))
	}

	output, err := container.Exec(containerID, restoreCmd)
	if err != nil {
		outputStr := string(output)
		if isAuthError(outputStr) {
			if errMsg, ok := credentialErrors[dbType]; ok {
				return reportFailure(fmt.Errorf("%s\n\nOriginal error: %s", errMsg, outputStr))
			}
		}
		return reportFailure(fmt.Errorf("database restore failed: %s: %w", outputStr, err))
	}

	log.Printf("[restore_database] restored database successfully")

	if err := a.Client.ReportRestoreComplete(backupID, true, ""); err != nil {
		log.Printf("[restore_database] warning: failed to report restore complete: %v", err)
	}

	return nil
}

func (a *Agent) processRedisRestore(backupID, containerID, restorePath string) error {
	log.Printf("[restore_database] restoring Redis from %s", restorePath)

	reportFailure := func(err error) error {
		if reportErr := a.Client.ReportRestoreComplete(backupID, false, err.Error()); reportErr != nil {
			log.Printf("[restore_database] warning: failed to report restore failure: %v", reportErr)
		}
		return err
	}

	rdbPath, err := getRedisRDBPath(containerID)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to get Redis RDB path: %w", err))
	}

	log.Printf("[restore_database] stopping Redis container %s", Truncate(containerID, 12))
	if err := container.Stop(containerID); err != nil {
		return reportFailure(fmt.Errorf("failed to stop container for restore: %w", err))
	}

	log.Printf("[restore_database] copying RDB file to %s", rdbPath)
	if err := copyFileToContainer(containerID, restorePath, rdbPath); err != nil {
		container.Start(containerID)
		return reportFailure(fmt.Errorf("failed to copy RDB to container: %w", err))
	}

	log.Printf("[restore_database] starting Redis container %s", Truncate(containerID, 12))
	if err := container.Start(containerID); err != nil {
		return reportFailure(fmt.Errorf("failed to start container after restore: %w", err))
	}

	log.Printf("[restore_database] restored Redis successfully")

	if err := a.Client.ReportRestoreComplete(backupID, true, ""); err != nil {
		log.Printf("[restore_database] warning: failed to report restore complete: %v", err)
	}

	return nil
}

func (a *Agent) processRedisRestoreToVolume(backupID, serviceID, storagePath, expectedChecksum string, storageConfig StorageConfig) error {
	log.Printf("[restore_database] restoring Redis directly to volume path (no container)")

	reportFailure := func(err error) error {
		if reportErr := a.Client.ReportRestoreComplete(backupID, false, err.Error()); reportErr != nil {
			log.Printf("[restore_database] warning: failed to report restore failure: %v", reportErr)
		}
		return err
	}

	volumePath := filepath.Join(a.DataDir, "volumes", serviceID, "data")
	rdbPath := filepath.Join(volumePath, "dump.rdb")

	restorePath := filepath.Join(os.TempDir(), fmt.Sprintf("redis-restore-%s.rdb", serviceID))
	defer os.Remove(restorePath)

	s3Client, err := createS3Client(storageConfig)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to create S3 client: %w", err))
	}

	if err := downloadFromS3(s3Client, storageConfig.Bucket, storagePath, restorePath); err != nil {
		return reportFailure(fmt.Errorf("failed to download from S3: %w", err))
	}

	checksum, err := calculateChecksum(restorePath)
	if err != nil {
		return reportFailure(fmt.Errorf("failed to calculate checksum: %w", err))
	}
	if checksum != expectedChecksum {
		return reportFailure(fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, checksum))
	}

	if err := os.MkdirAll(volumePath, 0755); err != nil {
		return reportFailure(fmt.Errorf("failed to create volume directory: %w", err))
	}

	if err := copyFile(restorePath, rdbPath); err != nil {
		return reportFailure(fmt.Errorf("failed to copy RDB file: %w", err))
	}

	log.Printf("[restore_database] restored Redis RDB to %s", rdbPath)

	if err := a.Client.ReportRestoreComplete(backupID, true, ""); err != nil {
		log.Printf("[restore_database] warning: failed to report restore complete: %v", err)
	}

	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

func copyFileToContainer(containerID, srcPath, destPath string) error {
	return container.CopyToContainer(containerID, srcPath, destPath)
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
