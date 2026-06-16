import { getDriveData } from "@/lib/items";
import { DriveApp } from "@/components/DriveApp";

// Bookmarkable route for the Trash view (7-day purge countdown).
export const dynamic = "force-dynamic";

export default async function TrashPage() {
  const { files, tags } = await getDriveData();
  return <DriveApp files={files} tags={tags} initialView="trash" />;
}
