import { getDriveData } from "@/lib/items";
import { DriveApp } from "@/components/DriveApp";

// Data berubah lewat bot/web actions → jangan cache statis.
export const dynamic = "force-dynamic";

export default async function Home() {
  const { files, tags } = await getDriveData();
  return <DriveApp files={files} tags={tags} />;
}
