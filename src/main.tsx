import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpFromLine, Check, ChevronDown, CircleHelp, FileImage, FileText, Gauge, Image as ImageIcon, LoaderCircle, LockKeyhole, Moon, RotateCcw, ShieldCheck, Sparkles, Sun, X, Zap } from 'lucide-react';
import './styles.css';

type Kind = 'image' | 'pdf';
type FileState = { index: number; name: string; status: string; error?: string; result?: { bytes: number; originalBytes: number; width?: number; height?: number; format: string; reduction: number; meetsTarget: boolean; warning?: string; pages?: number; downloadUrl: string } };
type JobState = { id: string; status: string; progress: number; files: FileState[] };
const quickTargets = [20, 50, 100, 200, 500, 1024];
const formats = ['webp', 'jpeg', 'png', 'avif'];
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

function App() {
  const query = new URLSearchParams(location.search);
  const keyword = location.pathname.match(/compress-(image|pdf)-(\d+)-kb/)?.[0];
  const [kind, setKind] = useState<Kind>(location.pathname.includes('compress-pdf') || query.get('tool') === 'pdf' ? 'pdf' : 'image');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [target, setTarget] = useState(keyword ? Number(keyword.match(/(\d+)-kb/)?.[1]) : 200);
  const [targetText, setTargetText] = useState(String(target));
  const [format, setFormat] = useState('webp');
  const [quality, setQuality] = useState(82);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [preset, setPreset] = useState('balanced');
  const [grayscale, setGrayscale] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [dark, setDark] = useState(localStorage.getItem('squeezely-theme') === 'dark');
  const inputRef = useRef<HTMLInputElement>(null);
  const isRunning = job?.status === 'queued' || job?.status === 'processing';
  const completed = job?.files.filter(file => file.status === 'done') ?? [];

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('squeezely-theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    document.title = keyword ? `Compress ${kind === 'image' ? 'image' : 'PDF'} to ${target} KB — Squeezely` : `${kind === 'image' ? 'Image' : 'PDF'} compressor — Squeezely`;
  }, [kind, target, keyword]);
  useEffect(() => {
    if (!job || !isRunning) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`);
        const data = await response.json();
        if (active && response.ok) setJob(data);
      } catch { /* transient connection issue; continue polling */ }
    };
    const timer = window.setInterval(poll, 850);
    void poll();
    return () => { active = false; clearInterval(timer); };
  }, [job?.id, isRunning]);

  const acceptFiles = useCallback((incoming: FileList | File[]) => {
    const accepted = Array.from(incoming).filter(file => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      return kind === 'pdf' ? ext === 'pdf' : ['jpg', 'jpeg', 'png', 'webp', 'avif', 'heic', 'heif'].includes(ext || '');
    }).slice(0, 12);
    if (!accepted.length) { setError(kind === 'pdf' ? 'Choose a PDF file to continue.' : 'Choose JPG, PNG, WebP, AVIF, or HEIC images.'); return; }
    setError(''); setJob(null); setSelectedFiles(current => [...current, ...accepted].slice(0, 12));
  }, [kind]);

  const startCompression = async () => {
    if (!selectedFiles.length || busy) return;
    setBusy(true); setError(''); setJob(null);
    const body = new FormData();
    selectedFiles.forEach(file => body.append('files', file));
    body.append('type', kind); body.append('targetKb', String(target)); body.append('format', format); body.append('quality', String(quality));
    body.append('width', width); body.append('height', height); body.append('preset', preset); body.append('grayscale', String(grayscale));
    try {
      const response = await fetch('/api/jobs', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start compression.');
      setJob(data);
    } catch (exception) { setError(exception instanceof Error ? exception.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  const cancelJob = async () => { if (job) await fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' }); };
  const retryFile = async (index: number) => {
    if (!job) return;
    const response = await fetch(`/api/jobs/${job.id}/retry/${index}`, { method: 'POST' }); const data = await response.json();
    if (!response.ok) { setError(data.error); return; }
    setJob(data);
  };
  const setKindAndClear = (next: Kind) => {
    setKind(next); setSelectedFiles([]); setJob(null); setError('');
    if (next === 'pdf') history.replaceState(null, '', '/?tool=pdf'); else history.replaceState(null, '', '/');
  };
  const imagePreview = useMemo(() => selectedFiles.find(file => file.type.startsWith('image/')) ? URL.createObjectURL(selectedFiles.find(file => file.type.startsWith('image/'))!) : '', [selectedFiles]);
  useEffect(() => () => { if (imagePreview) URL.revokeObjectURL(imagePreview); }, [imagePreview]);

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" onClick={e => { e.preventDefault(); setKindAndClear('image'); }}><span className="brand-mark"><Sparkles size={17} strokeWidth={2.5}/></span><span>squeezely<span className="brand-dot">.</span></span></a>
      <nav className="desktop-nav" aria-label="Main navigation"><a href="#tools">Tools</a><a href="#how">How it works</a><a href="#privacy">Privacy</a><a className="nav-pricing" href="#pricing">Plans <span>soon</span></a></nav>
      <div className="nav-actions"><button className="icon-btn" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setDark(value => !value)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button><a className="nav-cta" href="#compressor">Try it free <ArrowRight size={15}/></a></div>
    </header>

    <main>
      <section className="hero" id="tools"><div className="hero-copy"><div className="eyebrow"><span className="eyebrow-dot"/> SMALLER FILES, LESS FUSS</div><h1>Make your files<br/>feel <span>lighter.</span></h1><p className="hero-intro">Beautifully simple image and PDF compression. Get the size you need, keep the quality you love.</p><div className="hero-actions"><a className="button-primary" href="#compressor">Start compressing <ArrowRight size={17}/></a><span className="no-signup"><Check size={15}/> Free to use. No account needed.</span></div><div className="trust-row"><span><ShieldCheck size={16}/> Private by design</span><i/><span><Zap size={15}/> Results in seconds</span><i/><span>⌘ Up to 12 files at once</span></div></div>
        <div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/><div className="art-glow"/><div className="file-card card-back"><div className="mini-image blue-gradient"><ImageIcon size={26}/></div><span>photo-final.jpg</span><b>4.8 MB</b></div><div className="file-card card-front"><div className="mini-image peach-gradient"><span>JPG</span></div><span>summer.jpg</span><b>248 KB</b></div><div className="compress-badge"><span><ArrowDown size={14}/></span><strong>95% smaller</strong></div><div className="art-sparkle sparkle-a">✳</div><div className="art-sparkle sparkle-b">✦</div></div>
      </section>

      <section className="tool-section" id="compressor"><div className="section-heading"><div><div className="eyebrow">YOUR FILE WORKSPACE</div><h2>What are we slimming down?</h2><p>Choose a tool and set the size. We'll do the heavy lifting.</p></div><div className="tool-switch" role="tablist" aria-label="Choose file type"><button role="tab" aria-selected={kind === 'image'} className={kind === 'image' ? 'selected' : ''} onClick={() => setKindAndClear('image')}><FileImage size={17}/> Images</button><button role="tab" aria-selected={kind === 'pdf'} className={kind === 'pdf' ? 'selected' : ''} onClick={() => setKindAndClear('pdf')}><FileText size={17}/> PDF</button></div></div>
        <div className="workspace">
          <div className="workspace-main">
            <div className={`dropzone ${dragging ? 'dragging' : ''} ${selectedFiles.length ? 'has-files' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); acceptFiles(event.dataTransfer.files); }} onClick={() => inputRef.current?.click()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }} role="button" tabIndex={0} aria-label={`Choose ${kind === 'image' ? 'image' : 'PDF'} files`}>
              <input ref={inputRef} type="file" hidden multiple accept={kind === 'pdf' ? '.pdf,application/pdf' : 'image/jpeg,image/png,image/webp,image/avif,.heic,.heif'} onChange={event => { if (event.target.files) acceptFiles(event.target.files); event.currentTarget.value = ''; }}/>
              <div className="upload-icon"><ArrowUpFromLine size={22}/></div><strong>Drop your {kind === 'image' ? 'images' : 'PDFs'} here</strong><span>or <b>browse files</b> on your device</span><small>{kind === 'image' ? 'JPG, PNG, WEBP, AVIF, HEIC' : 'PDF documents'} · Up to 30 MB each · 12 files max</small>
            </div>
            {selectedFiles.length > 0 && !job && <div className="selected-list" aria-label="Selected files">{selectedFiles.map((file, i) => <div className="selected-file" key={`${file.name}-${i}`}><span className="file-icon">{kind === 'image' ? <ImageIcon size={17}/> : <FileText size={17}/>}</span><span className="file-name"><b>{file.name}</b><small>{formatBytes(file.size)}</small></span><button aria-label={`Remove ${file.name}`} className="icon-btn remove-file" onClick={event => { event.stopPropagation(); setSelectedFiles(items => items.filter((_, index) => index !== i)); }}><X size={16}/></button></div>)}</div>}
            {kind === 'image' && imagePreview && <div className="preview-comparison"><div className="preview-tile"><img src={imagePreview} alt="Selected original image preview"/><span>Original · {formatBytes(selectedFiles.find(file => file.type.startsWith('image/'))?.size || 0)}</span></div>{completed[0]?.result && <div className="preview-tile"><img src={`/api/jobs/${job!.id}/files/${completed[0].index}?preview=1`} alt="Compressed image preview"/><span>Compressed · {formatBytes(completed[0].result.bytes)}</span></div>}</div>}
            {job && <div className="results-area"><div className="results-head"><div><span className={`status-dot ${isRunning ? 'active' : 'complete'}`}/><strong>{isRunning ? 'Working on your files…' : job.status === 'error' ? 'Needs another try' : 'All done!'}</strong><small>{isRunning ? `Processing ${job.files.filter(file => file.status === 'done').length} of ${job.files.length} files` : 'Your files are ready to download.'}</small></div><div className="result-actions">{completed.length > 1 && <a className="button-secondary compact" href={`/api/jobs/${job.id}/zip`}><ArrowDownToLine size={15}/> Download ZIP</a>}{isRunning && <button className="icon-btn" aria-label="Cancel compression" title="Cancel" onClick={cancelJob}><X size={18}/></button>}</div></div>{isRunning && <div className="progress-track"><span style={{ width: `${job.progress || (job.status === 'processing' ? 8 : 2)}%` }}/></div>}
                {job.files.map(file => <div key={`${job.id}-${file.index}`} className="result-file"><span className={`result-check ${file.status === 'done' ? 'is-done' : file.status === 'error' ? 'is-error' : ''}`}>{file.status === 'done' ? <Check size={15}/> : file.status === 'error' ? <X size={15}/> : <LoaderCircle size={15} className="spin"/>}</span><div className="result-file-body"><div className="result-title"><b>{file.name}</b><span>{file.status === 'done' ? `${formatBytes(file.result!.originalBytes)} → ${formatBytes(file.result!.bytes)}` : file.status}</span></div>{file.result && <div className="result-stats"><span className="save-pill">{file.result.reduction.toFixed(0)}% smaller</span>{file.result.width && file.result.height && <span>{file.result.width} × {file.result.height}</span>}{file.result.pages && <span>{file.result.pages} pages</span>}<span>{file.result.format.toUpperCase()}</span>{!file.result.meetsTarget && <span className="target-note">Target not reached</span>}</div>}{file.result?.warning && <p className="file-warning">{file.result.warning}</p>}{file.error && <p className="file-error">{file.error} <button className="text-button" onClick={() => retryFile(file.index)}>Retry</button></p>}</div>{file.result && <a className="download-link" href={file.result.downloadUrl} download aria-label={`Download compressed ${file.name}`}><ArrowDownToLine size={16}/><span>Download</span></a>}</div>)}
                {!isRunning && <button className="start-over" onClick={() => { setJob(null); setSelectedFiles([]); setError(''); }}><RotateCcw size={14}/> Compress more files</button>}
              </div>}
            {error && <div className="error-banner" role="alert"><CircleHelp size={16}/>{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={14}/></button></div>}
            <div className="privacy-note"><LockKeyhole size={14}/><span>Files are private and automatically deleted after 30 minutes.</span><a href="#privacy">Learn more</a></div>
          </div>
          <aside className="settings-panel"><div className="settings-title"><div><Gauge size={17}/><strong>Compression settings</strong></div><span>STEP 1 OF 2</span></div><label className="field-label" htmlFor="target-input">Target file size</label><div className="target-input-wrap"><input id="target-input" type="number" min="5" max="50000" value={targetText} onChange={event => { setTargetText(event.target.value); const n = Number(event.target.value); if (n >= 5 && n <= 50000) setTarget(n); }} onBlur={() => { const n = Math.max(5, Math.min(50000, Number(targetText) || 200)); setTarget(n); setTargetText(String(n)); }}/><span>KB <ChevronDown size={13}/></span></div><div className="quick-targets" aria-label="Quick target sizes">{quickTargets.map(size => <button key={size} className={target === size ? 'active' : ''} onClick={() => { setTarget(size); setTargetText(String(size)); }}>{size === 1024 ? '1 MB' : `${size} KB`}</button>)}</div>
            {kind === 'image' ? <><div className="field-divider"/><label className="field-label" htmlFor="format-select">Output format</label><select id="format-select" value={format} onChange={event => setFormat(event.target.value)}>{formats.map(item => <option key={item} value={item}>{item.toUpperCase()} {item === 'webp' ? '· smaller files' : item === 'jpeg' ? '· widely supported' : item === 'png' ? '· transparent' : '· next-gen'}</option>)}</select><div className="quality-head"><label className="field-label" htmlFor="quality">Quality</label><span>{quality}%</span></div><input className="quality-slider" id="quality" type="range" min="25" max="100" value={quality} onChange={event => setQuality(Number(event.target.value))}/><div className="slider-labels"><span>Smaller file</span><span>Better quality</span></div><div className="resize-row"><label><span>Width</span><input type="number" placeholder="Auto" min="1" value={width} onChange={event => setWidth(event.target.value)}/></label><span className="resize-x">×</span><label><span>Height</span><input type="number" placeholder="Auto" min="1" value={height} onChange={event => setHeight(event.target.value)}/></label><span className="px-label">px</span></div><p className="setting-hint">Aspect ratio and orientation are preserved.</p></> : <><div className="field-divider"/><label className="field-label" htmlFor="preset">Compression preset</label><select id="preset" value={preset} onChange={event => setPreset(event.target.value)}><option value="quality">High quality · lighter image changes</option><option value="balanced">Balanced · recommended</option><option value="maximum">Maximum compression</option></select><label className="check-option"><input type="checkbox" checked={grayscale} onChange={event => setGrayscale(event.target.checked)}/><span>Convert embedded images to grayscale</span></label><p className="setting-hint">Searchable text and vector artwork stay intact. Rasterization is never applied.</p></>}
            <button className="compress-button" onClick={startCompression} disabled={!selectedFiles.length || busy || Boolean(isRunning)}>{busy ? <LoaderCircle size={18} className="spin"/> : <Sparkles size={17}/>}<span>{isRunning ? 'Compressing…' : 'Compress files'}</span><ArrowRight size={16}/></button><div className="target-help"><ShieldCheck size={14}/> We'll verify the actual output size. <a href="#how">How it works</a></div>
          </aside>
        </div>
      </section>

      <section className="how-section" id="how"><div className="section-heading centered"><div className="eyebrow">NO MYSTERY MEAT COMPRESSION</div><h2>Smaller in three simple steps.</h2><p>We give you the controls, show the real results, and keep your original untouched.</p></div><div className="steps-grid"><article className="step-card"><span className="step-num">01</span><div className="step-icon lav"><ArrowUpFromLine size={20}/></div><h3>Drop it in</h3><p>Choose one file or a whole batch. Your originals stay yours and never get overwritten.</p></article><article className="step-card"><span className="step-num">02</span><div className="step-icon mint"><Gauge size={20}/></div><h3>Pick your size</h3><p>Set a target, choose a format, and fine-tune your quality. No confusing presets required.</p></article><article className="step-card"><span className="step-num">03</span><div className="step-icon peach"><ArrowDownToLine size={20}/></div><h3>Take it with you</h3><p>Download each result or bundle the batch. We tell you exactly how much you saved.</p></article></div></section>

      <section className="tools-strip" id="pricing"><div className="strip-title"><span className="eyebrow">A LITTLE TOOLBOX</span><h2>One lighter file at a time.</h2><p>No account, paywall, or funny business. Just useful tools.</p></div><div className="tool-links"><a href="/?tool=image" onClick={e => { e.preventDefault(); setKindAndClear('image'); document.getElementById('compressor')?.scrollIntoView({ behavior: 'smooth' }); }}><span className="tool-link-icon img-link"><ImageIcon size={19}/></span><span><b>Image compressor</b><small>JPG, PNG, WebP, AVIF &amp; HEIC</small></span><ArrowRight size={17}/></a><a href="/?tool=pdf" onClick={e => { e.preventDefault(); setKindAndClear('pdf'); document.getElementById('compressor')?.scrollIntoView({ behavior: 'smooth' }); }}><span className="tool-link-icon pdf-link"><FileText size={19}/></span><span><b>PDF compressor</b><small>Smaller docs, searchable text</small></span><ArrowRight size={17}/></a><a href="/?tool=image" onClick={e => { e.preventDefault(); setKindAndClear('image'); document.getElementById('compressor')?.scrollIntoView({ behavior: 'smooth' }); }}><span className="tool-link-icon resize-link"><ArrowDown size={19}/></span><span><b>Image resizer</b><small>Fit dimensions while compressing</small></span><ArrowRight size={17}/></a></div></section>

      <section className="seo-links"><h2>Popular file sizes</h2><div>{['Compress image to 50 KB','Compress image to 100 KB','Compress image to 200 KB','Compress image to any KB','Compress PDF to 50 KB','Compress PDF to 100 KB','Compress PDF to 200 KB','Compress PDF to 500 KB'].map((label, index) => <a key={label} href={index < 4 ? `/compress-image-${[50,100,200][index] || 200}-kb` : `/compress-pdf-${[50,100,200,500][index - 4]}-kb`} onClick={event => { event.preventDefault(); const pdf = index >= 4; const size = pdf ? [50,100,200,500][index - 4] : [50,100,200][index] || 200; setKindAndClear(pdf ? 'pdf' : 'image'); setTarget(size); setTargetText(String(size)); history.pushState(null, '', index === 3 ? '/compress-image-any-kb' : `/${pdf ? 'compress-pdf' : 'compress-image'}-${size}-kb`); document.getElementById('compressor')?.scrollIntoView({ behavior: 'smooth' }); }}>{label}</a>)}</div></section>
    </main>

    <footer className="footer" id="privacy"><div className="footer-main"><div className="footer-brand"><a className="brand" href="/"><span className="brand-mark"><Sparkles size={17}/></span><span>squeezely<span className="brand-dot">.</span></span></a><p>Make your files lighter.<br/>Keep the good stuff.</p></div><div className="footer-links"><div><b>TOOLS</b><a href="#compressor" onClick={() => setKind('image')}>Image compressor</a><a href="#compressor" onClick={() => setKind('pdf')}>PDF compressor</a><a href="#compressor" onClick={() => setKind('image')}>Image resizer</a></div><div><b>THE IMPORTANT STUFF</b><a href="#privacy">Privacy policy</a><a href="#privacy">Terms of service</a><a href="mailto:hello@squeezely.example">Get in touch</a></div><div><b>YOUR FILES</b><span>Private by default</span><span>Auto-deleted in 30 min</span><span>No account required</span></div></div></div><div className="footer-bottom"><span>© 2026 Squeezely. Made for lighter days.</span><span>1 KB = 1,024 bytes · Real compression, honest results.</span></div></footer>
    <button className="mobile-fab" onClick={() => document.getElementById('compressor')?.scrollIntoView({ behavior: 'smooth' })}><ArrowLeft size={16}/> Go to compressor</button>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
