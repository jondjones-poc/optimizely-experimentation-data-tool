import { FakeDataForm } from "@/components/FakeDataForm";

export default function Home() {
  return (
    <div className="opt-app-shell flex-1">
      <header className="opt-brand-bar">
        <div className="opt-brand-bar-inner">
          <img
            className="opt-brand-mark"
            src="/brand/optimizely-o.png"
            alt=""
            width={36}
            height={36}
            aria-hidden
          />
          <img
            className="opt-brand-wordmark"
            src="/brand/optimizely-wordmark.png"
            alt="Optimizely"
            width={168}
            height={36}
          />
        </div>
      </header>
      <FakeDataForm />
    </div>
  );
}
