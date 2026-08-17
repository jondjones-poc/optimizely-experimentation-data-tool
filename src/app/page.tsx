import { FakeDataForm } from "@/components/FakeDataForm";

export default function Home() {
  return (
    <div className="opt-app-shell flex-1">
      <header className="opt-brand-bar">
        <div className="opt-brand-bar-inner">
          <span className="opt-brand-mark" aria-hidden>
            O
          </span>
          <span className="opt-brand-title">Optimizely</span>
        </div>
      </header>
      <FakeDataForm />
    </div>
  );
}
