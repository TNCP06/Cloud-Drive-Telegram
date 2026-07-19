import { getDriveData } from "@/lib/items";
import { DriveApp } from "@/components/DriveApp";
import { PrivateLock } from "@/components/PrivateLock";
import { PrivateAutoLock } from "@/components/PrivateAutoLock";
import { isPrivateUnlocked } from "@/app/actions/private";

// The PIN-gated Private space. Data is fetched and rendered ONLY after the unlock
// cookie is present, so private metadata never reaches the client before the PIN.
export const dynamic = "force-dynamic";

export default async function PrivatePage() {
  if (!(await isPrivateUnlocked())) {
    return <PrivateLock />;
  }
  const { files, tags, folders } = await getDriveData("private");
  return (
    <>
      <PrivateAutoLock />
      <DriveApp files={files} tags={tags} folders={folders} space="private" />
    </>
  );
}
