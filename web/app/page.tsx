import { getDriveData } from "@/lib/items";
import { DriveApp } from "@/components/DriveApp";
import { isPrivateUnlocked } from "@/app/actions/private";

// Data berubah lewat bot/web actions → jangan cache statis.
export const dynamic = "force-dynamic";

export default async function Home() {
  // privUnlocked lets the client offer "Move to private" with an inline PIN prompt
  // instead of crashing in the server action when the unlock cookie is absent.
  const [{ files, tags, folders }, privUnlocked] = await Promise.all([
    getDriveData(),
    isPrivateUnlocked(),
  ]);
  return <DriveApp files={files} tags={tags} folders={folders} privUnlocked={privUnlocked} />;
}
