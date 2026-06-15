import { getDriveData } from "@/lib/items";
import { DriveApp } from "@/components/DriveApp";

// Route bookmarkable ke view Sampah (countdown purge 7 hari).
export const dynamic = "force-dynamic";

export default async function TrashPage() {
  const { files, tags } = await getDriveData();
  return <DriveApp files={files} tags={tags} initialView="trash" />;
}
