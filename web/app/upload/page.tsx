import { getUploadJobs } from "@/lib/uploads";
import { listTags } from "@/app/actions";
import { UploadManager } from "@/components/UploadManager";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const [jobs, allTags] = await Promise.all([
    getUploadJobs(),
    listTags(),
  ]);
  return <UploadManager jobs={jobs} allTags={allTags} />;
}
