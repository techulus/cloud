"use server";

import { randomUUID } from "node:crypto";
import db from "@/db";
import { deployment, project, server, service } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createServer({ name }: { name: string }) {
  try {
    const { orgId } = await getOwner();

    await db.insert(server).values({
      id: randomUUID(),
      name: name ?? "Untitled Server",
      token: randomUUID(),
      secret: randomUUID(),
      organizationId: orgId,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error(error);
  }
}

export async function createProject({ name }: { name: string }) {
  try {
    const { orgId } = await getOwner();

    await db.insert(project).values({
      id: randomUUID(),
      name: name ?? "Untitled Project",
      organizationId: orgId,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error(error);
    return { error: "Failed to create project" };
  }
}

export async function createService({
  name,
  image,
  tag,
  projectId,
  type,
}: {
  name: string;
  image: string;
  tag: string;
  projectId: string;
  type: string;
}) {
  try {
    await db.insert(service).values({
      id: randomUUID(),
      name: name ?? "Untitled Service",
      projectId,
      configuration: {
        type,
        image,
        tag,
      },
      createdAt: new Date(),
    });
  } catch (error) {
    console.error(error);
    return { error: "Failed to create project" };
  }
}

export async function deployService({ serviceId }: { serviceId: string }) {
  try {
    return serviceId;
  } catch (error) {
    console.error(error);
  }
}

export async function createSecret({
  serviceId,
  key,
  value,
}: {
  serviceId: string;
  key: string;
  value: string;
}) {
  console.log(serviceId, key, value);
}

export async function deployAllServices({ projectId }: { projectId: string }) {
  const services = await db.query.service.findMany({
    where: eq(service.projectId, projectId),
  });

  for (const service of services) {
    await db.insert(deployment).values({
      id: randomUUID(),
      serviceId: service.id,
      status: "pending",
      createdAt: new Date(),
    });
  }

  revalidatePath(`/dashboard/project/${projectId}`);
}
