"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { processBotDrop } from "@/app/actions/botDrop";
import { listTags } from "@/app/actions";
import { TagPicker } from "@/components/TagPicker";
import type { Tag } from "@/lib/types";

export default function UploadBotPage() {
  const searchParams = useSearchParams();
  const msg_id = searchParams.get("msg_id");
  const chat_id = searchParams.get("chat_id");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [success, setSuccess] = useState(false);
  const [tags, setTags] = useState("");
  const [allTags, setAllTags] = useState<Tag[]>([]);

  // Load existing categories so the user can pick instead of retyping.
  useEffect(() => {
    listTags()
      .then(setAllTags)
      .catch(() => setAllTags([]));
  }, []);

  if (!msg_id || !chat_id) {
    return (
      <div className="botdrop-wrap"><div className="botdrop-card botdrop-error">
        <h2>Access Denied</h2>
        <p>This page can only be accessed via a special link from your Telegram Bot.</p>
      </div></div>
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const formData = new FormData(e.currentTarget);
    const res = await processBotDrop(formData);

    setLoading(false);
    if (res?.error) {
      setMessage({ text: res.error, isError: true });
    } else if (res?.success) {
      setSuccess(true);
      setMessage({ text: "File saved to Channel! You can close this page.", isError: false });
    }
  }

  if (success) {
    return (
      <div className="botdrop-wrap"><div className="botdrop-card botdrop-success">
        <div className="botdrop-icon">Success</div>
        <h2>Saved</h2>
        <p>File has been forwarded to the channel in the correct format. The bot is processing its indexing.</p>
        <button
          onClick={() => window.close()}
          className="btn primary"
        >
          Close Page
        </button>
      </div></div>
    );
  }

  return (
    <div className="botdrop-wrap"><div className="botdrop-card">
        <h1>Complete File Details</h1>
        <p className="botdrop-sub">Your file has been secured by the bot. Please fill in the details below to add it to the catalog.</p>

        {message && (
          <div className={`botdrop-message ${message.isError ? 'error' : 'success'}`}>
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="botdrop-form">
          <input type="hidden" name="msg_id" value={msg_id} />
          <input type="hidden" name="chat_id" value={chat_id} />

          <div>
            <label>Title <span>*</span></label>
            <input
              type="text"
              name="title"
              required
              autoFocus
              className="input"
              placeholder="e.g. Bali Holiday Video"
            />
          </div>

          <div>
            <label>File Category</label>
            <select
              name="kind"
              className="input"
            >
              <option value="media">Media (Video / Single Photo)</option>
              <option value="archive">Archive / Single Document</option>
            </select>
          </div>

          <div>
            <label>Categories</label>
            <input type="hidden" name="tags" value={tags} />
            <TagPicker
              value={tags}
              onChange={setTags}
              suggestions={allTags}
              placeholder="e.g. holiday, family, 2026"
            />
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="btn primary botdrop-submit"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
              ) : "Save to Catalog"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
