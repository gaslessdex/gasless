import { useEffect, useState } from 'react';

export function LoadingSequence({ onComplete, reducedMotion }: { onComplete: () => void; reducedMotion: boolean }) {
  const [step, setStep] = useState('3');
  useEffect(() => {
    const stages = reducedMotion ? [['GO', 180], ['DONE', 420]] as const : [['2', 620], ['1', 1180], ['GO', 1740], ['DONE', 2280]] as const;
    const timers = stages.map(([value, delay]) => window.setTimeout(() => value === 'DONE' ? onComplete() : setStep(value), delay));
    return () => timers.forEach(window.clearTimeout);
  }, [onComplete, reducedMotion]);

  return (
    <div className="loading-sequence" role="status" aria-live="polite">
      <div className="boot-stripes" />
      <div className="boot-center">
        <span className="boot-brand">GASLESS</span>
        <strong key={step}>{step}</strong>
      </div>
      <div className="boot-stripes boot-stripes-bottom" />
    </div>
  );
}
