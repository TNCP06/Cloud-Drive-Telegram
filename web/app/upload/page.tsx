import { getUploadJobs, getWatcherStatus, getBotStatus } from "@/lib/uploads";
import { listTags } from "@/app/actions";
import { UploadManager } from "@/components/UploadManager";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const [jobs, watcher, bot, allTags] = await Promise.all([
    getUploadJobs(),
    getWatcherStatus(),
    getBotStatus(),
    listTags(),
  ]);
  return <UploadManager jobs={jobs} watcher={watcher} bot={bot} allTags={allTags} />;
}
