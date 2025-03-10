import { Worker } from '@temporalio/worker';
import * as activities from './activities';

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities,
    namespace: 'default',
    taskQueue: 'service-deployment',
  });

  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});