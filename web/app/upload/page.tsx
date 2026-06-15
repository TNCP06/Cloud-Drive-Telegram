import { getUploadJobs, getWatcherStatus } from "@/lib/uploads";
import { UploadManager } from "@/components/UploadManager";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const [jobs, watcher] = await Promise.all([getUploadJobs(), getWatcherStatus()]);
  return <UploadManager jobs={jobs} watcher={watcher} />;
}
