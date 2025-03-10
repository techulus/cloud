export async function deployService(id: string): Promise<string> {
  console.log(`Deploying service ${id}.\n\n`);
  return `Deployed service ${id}`;
}