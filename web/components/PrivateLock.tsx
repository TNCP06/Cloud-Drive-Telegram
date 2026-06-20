"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Icon } from "@/lib/icons";
import { unlockPrivate } from "@/app/actions";

// Fixed-length PIN: typing the 6th digit auto-submits — no Enter / check tap needed.
const PIN_LENGTH = 6;

// Full-screen PIN gate for the Private space. A phone-style keypad you can also type
// on. The PIN is validated server-side (unlockPrivate); on success we refresh so the
// server /private route re-renders with the now-present unlock cookie.
export function PrivateLock() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const pinRef = useRef("");
  pinRef.current = pin;

  const exit = () => router.push("/");

  const submit = (value: string) => {
    if (value.length !== PIN_LENGTH || pending) return;
    startTransition(async () => {
      const res = await unlockPrivate(value);
      if (res.ok) {
        router.refresh();
      } else {
        setError(true);
        setPin("");
        pinRef.current = "";
        setTimeout(() => setError(false), 600);
      }
    });
  };

  // Append a digit; once the PIN is complete (PIN_LENGTH) it submits itself.
  // pinRef is updated synchronously so rapid presses don't race the state update.
  const press = (d: string) => {
    if (pending || pinRef.current.length >= PIN_LENGTH) return;
    setError(false);
    const next = pinRef.current + d;
    pinRef.current = next;
    setPin(next);
    if (next.length === PIN_LENGTH) submit(next);
  };
  const back = () => {
    const next = pinRef.current.slice(0, -1);
    pinRef.current = next;
    setPin(next);
  };

  // Keyboard support: digits type, Backspace deletes, Enter submits, Esc exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        press(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        back();
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit(pinRef.current);
      } else if (e.key === "Escape") {
        e.preventDefault();
        exit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <div className="pinlock">
      <div className={"pinbox" + (error ? " shake" : "")}>
        <div className="brand-mark" style={{ margin: "0 auto 6px" }}>
          <Image src="/logo.png" alt="logo" width={52} height={33} unoptimized style={{ display: "block" }} />
        </div>
        <div className="pin-lockicon">
          <Icon name="lock" size={26} />
        </div>
        <h2 className="pin-title">Private space</h2>
        <p className="pin-sub">Enter your PIN to continue</p>

        <div className="pin-dots">
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <span key={i} className={"pin-dot" + (i < pin.length ? " filled" : "")} />
          ))}
        </div>

        <div className="pin-pad">
          {keys.map((k) => (
            <button key={k} type="button" className="pin-key" onClick={() => press(k)} disabled={pending}>
              {k}
            </button>
          ))}
          <button type="button" className="pin-key ghost" onClick={back} disabled={pending} aria-label="Delete">
            <Icon name="backspace" size={22} />
          </button>
          <button type="button" className="pin-key" onClick={() => press("0")} disabled={pending}>
            0
          </button>
          <button
            type="button"
            className="pin-key accent"
            onClick={() => submit(pin)}
            disabled={pending || pin.length !== PIN_LENGTH}
            aria-label="Unlock"
          >
            <Icon name="check" size={22} />
          </button>
        </div>

        {error && <div className="pin-error">Incorrect PIN</div>}

        <button type="button" className="pin-cancel" onClick={exit}>
          <Icon name="back" size={16} /> Back to drive
        </button>
      </div>
    </div>
  );
}
