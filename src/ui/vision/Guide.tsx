import guide from '../../../docs/cv-owner-guide.md?raw';
import './vision.css';

/**
 * The owner's guide to the cameras (`docs/cv-owner-guide.md`, SCRUM-182), read on the shop PC or
 * the owner's phone with no internet: the file is built in. Only what the guide uses is read:
 * `#`/`##` headings, `-` list items and paragraphs.
 */
type Block = { kind: 'h1' | 'h2' | 'p'; text: string } | { kind: 'ul'; items: string[] };

export const guideBlocks = (md: string): Block[] => {
  const blocks: Block[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const last = blocks.at(-1);
    if (!line) continue;
    if (line.startsWith('## ')) blocks.push({ kind: 'h2', text: line.slice(3) });
    else if (line.startsWith('# ')) blocks.push({ kind: 'h1', text: line.slice(2) });
    else if (line.startsWith('- ')) {
      if (last?.kind === 'ul') last.items.push(line.slice(2)); else blocks.push({ kind: 'ul', items: [line.slice(2)] });
    } else blocks.push({ kind: 'p', text: line });
  }
  return blocks;
};

export default function Guide() {
  return (
    <div className="guide-page">
      <main className="guide" aria-label="How to set up the cameras">
        <a href="#vision" className="vision__link">Computer vision</a>
        {guideBlocks(guide).map((b, i) => {
          if (b.kind === 'ul') return <ul key={i}>{b.items.map((t) => <li key={t}>{t}</li>)}</ul>;
          if (b.kind === 'h1') return <h1 key={i}>{b.text}</h1>;
          if (b.kind === 'h2') return <h2 key={i}>{b.text}</h2>;
          return <p key={i}>{b.text}</p>;
        })}
      </main>
    </div>
  );
}
