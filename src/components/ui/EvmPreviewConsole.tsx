import { useMemo, useState, type ReactNode } from 'react';
import { PRODUCT_NETWORKS, type ProductNetwork, type ProductNetworkId } from '../../config/productNetworks';
import type { Feature } from '../../types/app';

function PreviewField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="preview-field"><span>{label}</span>{children}</label>;
}

export function EvmPreviewConsole({ feature, network }: { feature: Exclude<Feature, 'claim'>; network: ProductNetwork }) {
  const destinations = useMemo(() => PRODUCT_NETWORKS.filter((item) => item.id !== network.id), [network.id]);
  const [destination, setDestination] = useState<ProductNetworkId>(destinations[0]?.id ?? 'solana');

  if (feature === 'bridge') return <div className="evm-preview">
    <div className="preview-badge">PREVIEW · COMING SOON</div>
    <div className="preview-grid preview-grid--two">
      <PreviewField label="FROM NETWORK"><input value={network.displayName} readOnly /></PreviewField>
      <PreviewField label="TO NETWORK"><select value={destination} onChange={(event) => setDestination(event.target.value as ProductNetworkId)}>{destinations.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></PreviewField>
    </div>
    <PreviewField label="TOKEN"><button className="preview-select" type="button" disabled>SELECT TOKEN</button></PreviewField>
    <div className="preview-grid preview-grid--two">
      <PreviewField label="YOU SEND"><div className="preview-amount"><input placeholder="0.00" disabled /><button type="button" disabled>MAX</button></div></PreviewField>
      <PreviewField label="YOU RECEIVE"><input placeholder="—" disabled /></PreviewField>
    </div>
    <details className="preview-details"><summary>ROUTE / DETAILS <span>+</span></summary><p>Routes and exact amounts will appear here when Bridge is operational on {network.displayName}.</p></details>
    <button className="console-primary preview-primary" type="button" disabled>BRIDGE COMING SOON</button>
  </div>;

  if (feature === 'swap') return <div className="evm-preview">
    <div className="preview-badge">PREVIEW · COMING SOON</div>
    <div className="preview-asset"><span>YOU PAY</span><button type="button" disabled>TOKEN</button><input placeholder="AMOUNT" disabled /></div>
    <div className="preview-transfer" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M8 4v13m0 0-3-3m3 3 3-3" />
        <path d="M16 20V7m0 0-3 3m3-3 3 3" />
      </svg>
    </div>
    <div className="preview-asset"><span>YOU RECEIVE</span><button type="button" disabled>TOKEN</button><input placeholder="—" disabled /></div>
    <dl className="preview-summary"><div><dt>MINIMUM RECEIVED</dt><dd>—</dd></div></dl>
    <details className="preview-details"><summary>FEES &amp; DETAILS <span>+</span></summary><p>A live route and fee breakdown will appear before approval when this network is operational.</p></details>
    <button className="console-primary preview-primary" type="button" disabled>SWAP COMING SOON</button>
  </div>;

  return <div className="evm-preview">
    <div className="preview-badge">PREVIEW · COMING SOON</div>
    <PreviewField label="TOKEN"><button className="preview-select" type="button" disabled>SELECT TOKEN</button></PreviewField>
    <PreviewField label="AMOUNT"><div className="preview-amount"><input placeholder="0.00" disabled /><button type="button" disabled>MAX</button></div></PreviewField>
    <PreviewField label="RECIPIENT WALLET"><input placeholder="Wallet address" disabled /></PreviewField>
    <dl className="preview-summary"><div><dt>RECIPIENT RECEIVES</dt><dd>—</dd></div></dl>
    <details className="preview-details"><summary>FEES &amp; DETAILS <span>+</span></summary><p>Exact delivery and fees will appear before approval when Send is operational on {network.displayName}.</p></details>
    <button className="console-primary preview-primary" type="button" disabled>SEND COMING SOON</button>
  </div>;
}
