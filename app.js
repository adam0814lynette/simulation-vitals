(() => {
  'use strict';
  const STORAGE_KEY = 'sim-monitor-v1';
  const rhythmOptions = ['Normal sinus rhythm', 'Sinus tachycardia', 'Sinus bradycardia', 'Atrial fibrillation', 'Atrial flutter', 'PVCs', 'Monomorphic ventricular tachycardia', 'Ventricular fibrillation', 'Asystole'];
  const defaults = [
    { notes:'Baseline', hr:80, rhythm:rhythmOptions[0], spo2:98, sbp:120, dbp:80, etco2:5.0, rr:16, transition:'immediate', duration:0 },
    { notes:'Fast heart rate', hr:140, rhythm:rhythmOptions[1], spo2:96, sbp:118, dbp:72, etco2:5.0, rr:22, transition:'timed', duration:8 },
    { notes:'Low blood pressure', hr:105, rhythm:rhythmOptions[0], spo2:94, sbp:82, dbp:48, etco2:4.4, rr:24, transition:'timed', duration:10 },
    { notes:'Deterioration / A-fib', hr:150, rhythm:rhythmOptions[3], spo2:88, sbp:68, dbp:38, etco2:3.8, rr:30, transition:'timed', duration:10 },
    { notes:'Recovery', hr:92, rhythm:rhythmOptions[0], spo2:97, sbp:112, dbp:70, etco2:4.8, rr:18, transition:'timed', duration:8 }
  ];
  const blankPreset = () => ({ notes:'', hr:'', rhythm:rhythmOptions[0], spo2:'', sbp:'', dbp:'', etco2:'', rr:'', transition:'immediate', duration:8 });
  const $ = id => document.getElementById(id);
  let presets = loadPresets() || defaults.map(copyPreset);
  let state = vitalState(presets[0]), target = {...state}, transition = null;
  let activePreset = 0, paused = false, muted = true, audioContext = null, screenWakeLock = null, beat = null, afibSchedule = [], afibAudioIndex = 0, waveHistory = [], sampleClock = 0, raf = 0, lastFrame = 0, simTime = 0, scenarioStart = 0, idleTimer = 0;
  const canvases = ['ecgCanvas','plethCanvas'].map($);

  function copyPreset(p) { return {...p}; }
  function vitalState(p) { return { hr:+p.hr, spo2:+p.spo2, sbp:+p.sbp, dbp:+p.dbp, etco2:+p.etco2, rr:+p.rr }; }
  function mapFor(s) { return Math.round((s.sbp + 2*s.dbp) / 3); }
  function loadPresets() { try { const value=JSON.parse(localStorage.getItem(STORAGE_KEY)); return Array.isArray(value) && value.length ? value : null; } catch { return null; } }
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets)); $('saveStatus').textContent='Saved in this browser'; }
  function makeEditor() {
    const count = Math.max(1, Math.min(10, +$('presetCount').value));
    while (presets.length < count) presets.push(copyPreset(defaults[Math.min(presets.length, defaults.length-1)]));
    presets.length = count;
    $('presetEditor').innerHTML = `<div class="table-header"><span>State</span><span>Notes</span><span>HR</span><span>Rhythm</span><span>SpO₂ (%)</span><span>Sys</span><span>Dia</span><span>ETCO₂</span><span>RR</span><span>Transition</span></div>` + presets.map((p,i) => `<section class="preset-form" data-index="${i}"><h2>State ${i+1}</h2><div class="field-grid"><label class="field notes-field">Operator notes<textarea data-key="notes">${escapeHtml(p.notes || '')}</textarea></label><label class="field">Heart rate<input data-key="hr" type="number" min="20" max="240" value="${p.hr}"></label><label class="field">Rhythm<select data-key="rhythm">${rhythmOptions.map(r=>`<option ${r===p.rhythm?'selected':''}>${r}</option>`).join('')}</select></label><label class="field">SpO₂ (%)<input data-key="spo2" type="number" min="0" max="100" step="1" value="${p.spo2}" aria-label="SpO2 percentage"></label><label class="field">Systolic BP<input data-key="sbp" type="number" min="30" max="260" value="${p.sbp}"></label><label class="field">Diastolic BP<input data-key="dbp" type="number" min="15" max="180" value="${p.dbp}"></label><label class="field">ETCO₂ (kPa)<input data-key="etco2" type="number" min="0" max="15" step="0.1" value="${p.etco2}"></label><label class="field">Respiratory rate<input data-key="rr" type="number" min="4" max="60" value="${p.rr}"></label></div><div class="transition-row"><strong>Transition:</strong><label><input type="radio" name="transition-${i}" value="immediate" ${p.transition==='immediate'?'checked':''}> Immediate</label><label><input type="radio" name="transition-${i}" value="timed" ${p.transition!=='immediate'?'checked':''}> Over <input data-key="duration" type="number" min="1" max="120" value="${p.duration || 8}"> sec</label></div></section>`).join('');
  }
  function readEditor() { document.querySelectorAll('.preset-form').forEach((form,i) => { form.querySelectorAll('[data-key]').forEach(el => { const key=el.dataset.key; presets[i][key] = el.type==='number' ? +el.value : el.value; }); presets[i].transition = form.querySelector(`input[name="transition-${i}"]:checked`).value; }); save(); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async function requestScreenWakeLock() {
    if (!('wakeLock' in navigator) || document.hidden) return;
    try {
      if (!screenWakeLock) screenWakeLock = await navigator.wakeLock.request('screen');
      screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
    } catch {}
  }
  async function releaseScreenWakeLock() {
    if (!screenWakeLock) return;
    try { await screenWakeLock.release(); } catch {}
    screenWakeLock = null;
  }
  function showMonitor() { readEditor(); $('setupView').classList.add('hidden'); $('monitorView').classList.remove('hidden'); buildPresetButtons(); activePreset=0; state=vitalState(presets[0]); target={...state}; scenarioStart=performance.now(); simTime=0; sampleClock=0; waveHistory=[]; beat=null; resetAfibSchedule(); resizeAll(); updateDisplay(); startLoop(); requestScreenWakeLock(); }
  function buildPresetButtons() { $('presetButtons').innerHTML=presets.map((_,i)=>`<button class="preset-button" data-preset="${i}" title="Select preset ${i+1} — press ${i===9?'0':i+1}">${i+1}</button>`).join(''); markPreset(); }
  function markPreset() { document.querySelectorAll('.preset-button').forEach((b,i)=>b.classList.toggle('active',i===activePreset)); }
  function selectPreset(index) { if (!presets[index]) return; readEditor(); activePreset=index; const p=presets[index]; target=vitalState(p); state=transition && transition.active ? {...state} : {...state}; if (p.transition==='immediate' || !p.duration) { state={...target}; transition=null; } else transition={active:true,start:performance.now(),duration:p.duration*1000,from:{...state},to:{...target}}; beat=null; resetAfibSchedule(); markPreset(); updateDisplay(); }
  function updateDisplay() { $('hrValue').textContent=Math.round(state.hr); $('spo2Value').textContent=Math.round(state.spo2); $('sbpValue').textContent=Math.round(state.sbp); $('dbpValue').textContent=Math.round(state.dbp); $('mapValue').textContent=mapFor(state); $('etco2Value').textContent=state.etco2.toFixed(1); $('rrValue').textContent=Math.round(state.rr); }
  function resizeCanvas(canvas) { const rect=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1; if (!rect.width||!rect.height) return; const w=Math.round(rect.width*dpr), h=Math.round(rect.height*dpr); if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h; const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);} }
  function resizeAll() { canvases.forEach(resizeCanvas); }
  function lerp(a,b,t){return a+(b-a)*t;}
  function updateTransition(now) { if(!transition?.active) return; const t=Math.min(1,(now-transition.start)/transition.duration); Object.keys(state).forEach(k=>state[k]=lerp(transition.from[k],transition.to[k],t)); if(t>=1) transition=null; }
  function gaussian(x, center, width) { const d=(x-center)/width; return Math.exp(-d*d*2); }
  function phaseAt(t, period) { return ((t%period)+period)%period/period; }
  function sinusEcg(phase) { return gaussian(phase,.18,.04)*.16 - gaussian(phase,.285,.018)*.16 + gaussian(phase,.30,.017)*1.0 - gaussian(phase,.335,.022)*.28 + gaussian(phase,.52,.095)*.3; }
  function afibEcg(phase,t) { return Math.sin(t*31)*.025 + Math.sin(t*47)*.018 + gaussian(phase,.30,.017)*1.0 - gaussian(phase,.335,.022)*.28 + gaussian(phase,.52,.095)*.25; }
  function flutterEcg(phase,t) { const saw=((t*5.2)%1+1)%1; return (saw<.82?saw*.055:(1-saw)*.055) + gaussian(phase,.30,.017)*1.0 - gaussian(phase,.335,.022)*.28 + gaussian(phase,.52,.095)*.25; }
  function pvcEcg(phase) { return -gaussian(phase,.24,.045)*.35 + gaussian(phase,.34,.05)*.78 - gaussian(phase,.47,.055)*.42 + gaussian(phase,.68,.11)*.18; }
  function vtEcg(phase) { return gaussian(phase,.28,.065)*.75 - gaussian(phase,.48,.08)*.58 + gaussian(phase,.68,.08)*.3; }
  function vfEcg(t) { return Math.sin(t*18)*.13 + Math.sin(t*31)*.09 + Math.sin(t*43)*.055 + Math.sin(t*67)*.035; }
  function asystoleEcg(t) { return Math.sin(t*17)*.008 + Math.sin(t*29)*.005; }
  function resetAfibSchedule() { afibSchedule=[]; afibAudioIndex=0; if (presets[activePreset]?.rhythm !== 'Atrial fibrillation') return; const base=60/Math.max(20,state.hr); let t=simTime-20; while(t<simTime+35){ t += base*(.68+Math.random()*.64); afibSchedule.push(t); } while(afibAudioIndex<afibSchedule.length && afibSchedule[afibAudioIndex]<=simTime) afibAudioIndex++; }
  function ensureAfibSchedule() { if (presets[activePreset]?.rhythm !== 'Atrial fibrillation') return; if (!afibSchedule.length) resetAfibSchedule(); const base=60/Math.max(20,state.hr); while (afibSchedule[afibSchedule.length-1] < simTime+35) { const last=afibSchedule[afibSchedule.length-1]; afibSchedule.push(last+base*(.68+Math.random()*.64)); } }
  function previousAfibBeat(t) { ensureAfibSchedule(); let previous=-Infinity; for (const event of afibSchedule) { if (event>t) break; previous=event; } return previous; }
  function afibTrace(t) { const previous=previousAfibBeat(t), since=t-previous; return (since>=0 && since<.8) ? afibEcg(.30+since,state.hr*t) : Math.sin(t*31)*.025 + Math.sin(t*47)*.018; }
  function afibPulsePhase(t) { const previous=previousAfibBeat(t), since=t-previous, period=60/Math.max(20,state.hr); return since>=0 && since<period ? since/period : 1; }
  function isNoPulseRhythm(rhythm) { return rhythm==='Ventricular fibrillation' || rhythm==='Asystole'; }
  function rhythmEcgAt(t, phase, rhythm) { if(rhythm==='Atrial fibrillation')return afibTrace(t); if(rhythm==='Atrial flutter')return flutterEcg(phase,t); if(rhythm==='PVCs')return Math.floor(t/Math.max(.01,60/Math.max(20,state.hr)))%3===2?pvcEcg(phase):sinusEcg(phase); if(rhythm==='Monomorphic ventricular tachycardia')return vtEcg(phase); if(rhythm==='Ventricular fibrillation')return vfEcg(t); if(rhythm==='Asystole')return asystoleEcg(t); return sinusEcg(phase); }
  function pulseShape(phase, arterial=false) { if (phase < .10) return phase / .10; if (phase < .22) return 1 - (phase-.10)/.12*.18; if (phase < .62) return .82 - (phase-.22)/.40*.47; if (phase < .72) return .35 - (phase-.62)/.10*.10; return 0; }
  function smoothstep(x) { return x*x*(3-2*x); }
  function plethShape(phase) {
    if (phase<0 || phase>=1) return 0;
    if (phase<.085) return smoothstep(phase/.085);
    const elapsed=phase-.085;
    const primary=.98*Math.exp(-elapsed*3.35);
    const notch=.15*Math.exp(-Math.pow((phase-.31)/.032,2));
    const shoulder=.105*Math.exp(-Math.pow((phase-.37)/.055,2));
    const taper=phase>.78 ? 1-smoothstep((phase-.78)/.22) : 1;
    return Math.max(0,(primary-notch+shoulder)*taper);
  }
  function peripheralPlethAt(t,rhythm) { if(isNoPulseRhythm(rhythm))return 0; const pulseDelay=.16, pulseTime=t-pulseDelay, basePeriod=60/Math.max(20,state.hr), phase=rhythm==='Atrial fibrillation'?afibPulsePhase(pulseTime):phaseAt(pulseTime,basePeriod); let amplitude=.72; if(rhythm==='PVCs'&&Math.floor(pulseTime/Math.max(.01,basePeriod))%3===2)amplitude=.32; if(rhythm==='Monomorphic ventricular tachycardia')amplitude=.48; return plethShape(phase)*amplitude; }
  function sampleWaves(t) { const rhythm=presets[activePreset]?.rhythm||rhythmOptions[0], basePeriod=60/Math.max(20,state.hr), p=phaseAt(t,basePeriod), ecg=rhythmEcgAt(t,p,rhythm), pulse=peripheralPlethAt(t,rhythm); const rp=phaseAt(t,60/Math.max(4,state.rr)); return {ecg,pleth:pulse,arterial:pulse,capno:rp<.12?rp/.12*.82:rp<.58?.82:rp<.7?.82*(1-(rp-.58)/.12):0}; }
  function addWaveSamples() { const interval=1/120; while(sampleClock<=simTime){ waveHistory.push({t:sampleClock,...sampleWaves(sampleClock)}); sampleClock+=interval; } const cutoff=simTime-16; while(waveHistory.length && waveHistory[0].t<cutoff) waveHistory.shift(); }
  function drawTrace(canvas, kind) { const ctx=canvas.getContext('2d'), w=canvas.clientWidth, h=canvas.clientHeight; if(!w||!h)return; const speed=kind==='capno'?70:95, start=simTime-w/speed; ctx.clearRect(0,0,w,h); ctx.strokeStyle='rgba(130,165,158,.11)';ctx.lineWidth=1;ctx.beginPath();for(let x=0;x<w;x+=64){ctx.moveTo(x,0);ctx.lineTo(x,h);}for(let y=0;y<h;y+=32){ctx.moveTo(0,y);ctx.lineTo(w,y);}ctx.stroke();ctx.strokeStyle=kind==='ecg'?'#4bea91':kind==='pleth'?'#eadb54':kind==='arterial'?'#ff796e':'#edf3f0'; ctx.lineWidth=1.8; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.shadowBlur=kind==='ecg'?4:2;ctx.shadowColor=ctx.strokeStyle;ctx.beginPath(); let started=false; for(const sample of waveHistory){ if(sample.t<start)continue; const x=(sample.t-start)*speed, y=h/2-sample[kind]*h*.38; if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y); } if(started)ctx.stroke();ctx.shadowBlur=0; }
  function nextBeat(now) { const rhythm=presets[activePreset]?.rhythm||rhythmOptions[0]; if(rhythm==='Ventricular fibrillation'||rhythm==='Asystole')return; if(rhythm==='Atrial fibrillation'){ ensureAfibSchedule(); while(afibAudioIndex<afibSchedule.length && simTime>=afibSchedule[afibAudioIndex]){if(!muted)beep();afibAudioIndex++;} return; } const base=60/Math.max(20,state.hr); if(!beat || now>=beat.next){ const count=beat?.count||0; beat={next:now+base*1000,count:count+1}; if(!muted) beep(rhythm==='PVCs'&&count%3===2?'pvc':rhythm==='Monomorphic ventricular tachycardia'?'vt':'normal'); } }
  function beep(kind='normal'){ try{ audioContext ||= new (window.AudioContext||window.webkitAudioContext)(); if(audioContext.state==='suspended')audioContext.resume(); const o=audioContext.createOscillator(),g=audioContext.createGain();o.frequency.value=kind==='pvc'?620:kind==='vt'?560:760;o.type='sine';g.gain.setValueAtTime(.0001,audioContext.currentTime);g.gain.exponentialRampToValueAtTime(.045,audioContext.currentTime+.005);g.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+.075);o.connect(g).connect(audioContext.destination);o.start();o.stop(audioContext.currentTime+.08);}catch{} }
  function animate(now){ raf=requestAnimationFrame(animate); if(!lastFrame)lastFrame=now; const dt=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;if(!paused){simTime+=dt;updateTransition(now);updateDisplay();nextBeat(now);addWaveSamples();canvases.forEach((c,i)=>drawTrace(c,['ecg','pleth'][i])); $('clock').textContent=formatTime((now-scenarioStart)/1000);} }
  function startLoop(){ if(!raf)raf=requestAnimationFrame(animate); }
  function formatTime(s){s=Math.max(0,Math.floor(s));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
  function wakeControls(){const controls=$('monitorView').querySelector('.monitor-controls');controls.classList.remove('idle');clearTimeout(idleTimer);idleTimer=setTimeout(()=>controls.classList.add('idle'),5000);}
  function toggleMute(){muted=!muted;$('muteButton').innerHTML=`<span id="muteIcon" aria-hidden="true">${muted?'🔇':'🔊'}</span> ${muted?'Unmute':'Mute'}`;if(!muted)beep();wakeControls();}
  function togglePause(){paused=!paused;$('pauseButton').textContent=paused?'Resume':'Pause';wakeControls();}
  $('presetCount').onchange=()=>{readEditor();makeEditor();};
  $('presetEditor').addEventListener('input',readEditor);
  $('presetEditor').addEventListener('change',readEditor);
  $('startButton').onclick=showMonitor;
  $('clearButton').onclick=()=>{presets=Array.from({length:+$('presetCount').value},blankPreset);makeEditor();save();$('saveStatus').textContent='Presets cleared. Enter new values to start over.';};
  $('presetButtons').onclick=e=>{const b=e.target.closest('[data-preset]');if(b){selectPreset(+b.dataset.preset);wakeControls();}};
  $('muteButton').onclick=toggleMute; $('pauseButton').onclick=togglePause;
  $('resetButton').onclick=()=>{cancelAnimationFrame(raf);raf=0;paused=false;clearTimeout(idleTimer);releaseScreenWakeLock();$('monitorView').classList.add('hidden');$('setupView').classList.remove('hidden');makeEditor();};
  $('monitorView').addEventListener('pointermove',wakeControls); $('monitorView').addEventListener('keydown',wakeControls);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('monitorView').classList.contains('hidden'))requestScreenWakeLock();});
  window.addEventListener('keydown',e=>{if($('monitorView').classList.contains('hidden')||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return; if(/^[1-9]$/.test(e.key)){const i=+e.key-1;if(presets[i])selectPreset(i);}else if(e.key==='0'&&presets[9])selectPreset(9);else if(e.key.toLowerCase()==='m')toggleMute();else if(e.code==='Space'){e.preventDefault();togglePause();}else if(e.key.toLowerCase()==='r')$('resetButton').click();wakeControls();});
  window.addEventListener('resize',resizeAll); makeEditor();
})();
