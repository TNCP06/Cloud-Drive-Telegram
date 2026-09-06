import { getUploadJobs, getUploadJobStats } from "@/lib/uploads";
import { BackupHpManager } from "@/components/BackupHpManager";

export const dynamic = "force-dynamic";

// One-button archive for the old phone: folder picks accumulate in one queue,
// everything downstream (staging, splitting, Telegram upload) is automatic,
// and failures are retried in bulk. See BUSINESS-FLOWS.md (backup flow).
export default async function BackupHpPage() {
  const [jobs, stats] = await Promise.all([getUploadJobs(), getUploadJobStats()]);
  return <BackupHpManager jobs={jobs} stats={stats} />;
}
