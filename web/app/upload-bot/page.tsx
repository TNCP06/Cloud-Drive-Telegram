"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { processBotDrop } from "./actions";
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
      <div className="p-8 max-w-lg mx-auto mt-10 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400">
        <h2 className="text-xl font-bold mb-2">Access Denied</h2>
        <p>This page can only be accessed via a special link from your Telegram Bot.</p>
      </div>
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
      <div className="p-8 max-w-lg mx-auto mt-10 bg-green-500/10 border border-green-500/20 rounded-xl text-center">
        <div className="text-4xl mb-4">🎉</div>
        <h2 className="text-2xl font-bold text-green-400 mb-2">Success!</h2>
        <p className="text-zinc-300">File has been forwarded to the channel in the correct format. The bot is processing its indexing.</p>
        <button
          onClick={() => window.close()}
          className="mt-6 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg border border-zinc-700 transition"
        >
          Close Page
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-lg mx-auto mt-10">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl">
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">Complete File Details</h1>
        <p className="text-sm text-zinc-400 mb-6">Your file has been secured by the bot. Please fill in the details below to add it to the catalog.</p>

        {message && (
          <div className={`p-4 rounded-lg mb-6 text-sm ${message.isError ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-green-500/10 text-green-400 border border-green-500/20'}`}>
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <input type="hidden" name="msg_id" value={msg_id} />
          <input type="hidden" name="chat_id" value={chat_id} />

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Title <span className="text-red-400">*</span></label>
            <input
              type="text"
              name="title"
              required
              autoFocus
              className="w-full bg-black/50 border border-zinc-700 rounded-lg px-4 py-2.5 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition placeholder:text-zinc-600"
              placeholder="e.g. Bali Holiday Video"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">File Category</label>
            <select
              name="kind"
              className="w-full bg-black/50 border border-zinc-700 rounded-lg px-4 py-2.5 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition appearance-none"
            >
              <option value="media">Media (Video / Single Photo)</option>
              <option value="archive">Archive / Single Document</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Categories</label>
            <input type="hidden" name="tags" value={tags} />
            <TagPicker
              value={tags}
              onChange={setTags}
              suggestions={allTags}
              placeholder="e.g. holiday, family, 2026"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-lg transition shadow-[0_0_15px_rgba(37,99,235,0.3)] disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center"
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
