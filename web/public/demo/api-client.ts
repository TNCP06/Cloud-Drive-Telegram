export interface DriveFile {
  id: number;
  slug: string;
  name: string;
  kind: "archive" | "media";
  size: number;
}

export async function listFiles(space = "main"): Promise<DriveFile[]> {
  const res = await fetch("/api/files?space=" + space);
  if (!res.ok) throw new Error("list failed: " + res.status);
  return res.json();
}
