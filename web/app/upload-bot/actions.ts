"use server";

export async function processBotDrop(formData: FormData) {
  const msg_id = formData.get("msg_id")?.toString();
  const chat_id = formData.get("chat_id")?.toString();
  const title = formData.get("title")?.toString().trim();
  const kind = formData.get("kind")?.toString() || "media";
  const tagsStr = formData.get("tags")?.toString() || "";

  if (!msg_id || !chat_id || !title) {
    return { error: "Semua data (termasuk judul) wajib diisi." };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

  if (!BOT_TOKEN || !STORAGE_CHANNEL_ID) {
    return { error: "Konfigurasi BOT_TOKEN atau STORAGE_CHANNEL_ID di Vercel belum diisi." };
  }

  // Format caption sesuai kontrak
  const tags = tagsStr.split(",").map((t) => t.trim()).filter((t) => t.length > 0).join(", ");
  const caption = `${title} | 1/1 | ${tags}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: STORAGE_CHANNEL_ID,
        from_chat_id: chat_id,
        message_id: parseInt(msg_id, 10),
        caption: caption,
      }),
    });

    const result = await res.json();

    if (!result.ok) {
      return { error: `Telegram Error: ${result.description}` };
    }

    return { success: true };
  } catch (err: any) {
    return { error: err.message || "Gagal menghubungi Telegram." };
  }
}
