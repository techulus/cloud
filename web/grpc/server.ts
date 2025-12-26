import * as grpc from "@grpc/grpc-js";
import { AgentServiceService } from "./generated/proto/agent";
import { createAgentService } from "./services/agent-service";
import { startWorkDispatcher, stopWorkDispatcher } from "./handlers/work";

const PORT = process.env.GRPC_PORT || "50051";

function main(): void {
  const server = new grpc.Server();

  server.addService(AgentServiceService, createAgentService());

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (error, port) => {
      if (error) {
        console.error("Failed to bind gRPC server:", error);
        process.exit(1);
      }

      console.log(`gRPC server listening on port ${port}`);
      startWorkDispatcher();
    }
  );

  process.on("SIGINT", () => {
    console.log("Shutting down gRPC server...");
    stopWorkDispatcher();
    server.tryShutdown((error) => {
      if (error) {
        console.error("Error shutting down:", error);
        process.exit(1);
      }
      console.log("gRPC server stopped");
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    console.log("Shutting down gRPC server...");
    stopWorkDispatcher();
    server.tryShutdown((error) => {
      if (error) {
        console.error("Error shutting down:", error);
        process.exit(1);
      }
      console.log("gRPC server stopped");
      process.exit(0);
    });
  });
}

main();
