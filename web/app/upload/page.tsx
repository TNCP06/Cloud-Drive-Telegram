import { getUploadJobs, getWatcherStatus } from "@/lib/uploads";
import { listTags } from "@/app/actions";
import { UploadManager } from "@/components/UploadManager";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const [jobs, watcher, allTags] = await Promise.all([
    getUploadJobs(),
    getWatcherStatus(),
    listTags(),
  ]);
  return <UploadManager jobs={jobs} watcher={watcher} allTags={allTags} />;
}
