#!/bin/bash
set -e

cd "$(dirname "$0")"

protoc --go_out=. --go_opt=module=techulus/cloud-agent \
       --go-grpc_out=. --go-grpc_opt=module=techulus/cloud-agent \
       --proto_path=../proto ../proto/agent.proto
