const DEFAULTS = {
  serial: {mode:'physical', port:'', baudrate:115200, bytesize:8, parity:'N', stopbits:1, flowControl:'none', rts:true, dtr:true},
  emulator: {vid:'FFFF', pid:'0001', port:'VIRTUAL-COM1', baudrate:115200, bytesize:8, parity:'N', stopbits:1, flowControl:'none', rts:true, dtr:true, cts:false, dsr:false, dcd:false, ri:false},
  display: {echo:true, millis:true, autoscroll:true, raw:true, saveReception:false},
  transport: {encoding:'utf-8', lineEnding:'lf', rxConversion:'none', fileDelay:50},
  logging: {directory:'', filename:'serial_{date}_{time}.txt'},
  shortcuts: {F1:'none',F2:'none',F3:'none',F4:'none',F5:'refresh_ports',F6:'none',F7:'none',F8:'none',F9:'none',F10:'none',F11:'fullscreen',F12:'none'},
  filters: [],
  buttons: [
    {name:'STATUS', value:'STATUS?', color:'#ed5b20',key:'none'},
    {name:'START', value:'START', color:'#4e8c67',key:'none'},
    {name:'STOP', value:'STOP', color:'#ba3b36',key:'none'}
  ],
  colors: [
    {type:'literal',keyword:'ERROR',color:'#ff5a4f'},
    {type:'literal',keyword:'OK',color:'#54c47c'},
    {type:'literal',keyword:'WARNING',color:'#e4a83a'}
  ]
};

let settings = structuredClone(DEFAULTS);
let language = {};
let connected = false;
let connectionPending = false;
let paused = false;
let pendingMessages = [];
let sequenceLines=[];
let sequenceCancelled=false;
const automatedEchoes = new Map();
const api = () => window.pywebview?.api;
const t = key => language[key] || key;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function applyLanguage() {
  document.title = t('app_title');
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
}

function applyTheme(theme) {
  const colors = theme?.colors || {};
  const variables = {paper:'--paper',paper_secondary:'--paper2',ink:'--ink',muted:'--muted',line:'--line',accent:'--orange',dark:'--dark',success:'--green',danger:'--danger',terminal_background:'--terminal-bg',terminal_text:'--terminal-text'};
  Object.entries(variables).forEach(([key, variable]) => { if (colors[key]) document.documentElement.style.setProperty(variable, colors[key]); });
  if (theme?.typography?.family) document.documentElement.style.fontFamily = theme.typography.family;
  configureResizeHandles(theme?.window_resizable === true);
}

function configureResizeHandles(enabled) {
  document.querySelectorAll('.resize-handle').forEach(handle => handle.remove());
  if (!enabled) return;
  ['n','ne','e','se','s','sw','w','nw'].forEach(edge => {
    const handle=document.createElement('div');
    handle.className=`resize-handle resize-${edge}`;
    handle.dataset.edge=edge;
    document.body.append(handle);
  });
}

let pendingResize=null;
let resizeRunning=false;
async function flushResize() {
  if(resizeRunning)return;
  resizeRunning=true;
  while(pendingResize){
    const request=pendingResize; pendingResize=null;
    await api().resize_window(request.width,request.height,request.edge);
  }
  resizeRunning=false;
}

document.addEventListener('pointerdown',event => {
  const handle=event.target.closest('.resize-handle');
  if(!handle)return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const edge=handle.dataset.edge;
  const startX=event.screenX,startY=event.screenY,startWidth=window.innerWidth,startHeight=window.innerHeight;
  const update=pointer => {
    const deltaX=pointer.screenX-startX,deltaY=pointer.screenY-startY;
    const width=Math.max(1100,startWidth+(edge.includes('w')?-deltaX:edge.includes('e')?deltaX:0));
    const height=Math.max(700,startHeight+(edge.includes('n')?-deltaY:edge.includes('s')?deltaY:0));
    pendingResize={width:Math.round(width),height:Math.round(height),edge}; flushResize();
  };
  const move=pointer => update(pointer);
  const stop=pointer => {update(pointer);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',stop);handle.removeEventListener('pointercancel',stop);};
  handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',stop);
  handle.addEventListener('pointercancel',stop);
});

function toast(message, error=false) {
  const element = document.querySelector('#toast');
  element.textContent = String(message).toUpperCase();
  element.style.borderColor = error ? 'var(--danger)' : 'var(--orange)';
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2400);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === name));
}

function showConnectionPane(name) {
  document.querySelectorAll('.connection-pane').forEach(pane => pane.classList.toggle('active', pane.id === `connection-${name}`));
  document.querySelectorAll('.connection-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.connectionView === name));
}

function showOptionPane(name) {
  document.querySelectorAll('.option-pane').forEach(pane => pane.classList.toggle('active', pane.id === `option-${name}`));
  document.querySelectorAll('.option-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.optionView === name));
}

function colorRulePattern(rule) {
  const patterns={
    date_dmy:'\\b(?:0[1-9]|[12]\\d|3[01])\\/(?:0[1-9]|1[0-2])\\/\\d{4}\\b',
    date_ymd:'\\b\\d{4}\\/(?:0[1-9]|1[0-2])\\/(?:0[1-9]|[12]\\d|3[01])\\b',
    time_hm:'\\b(?:[01]\\d|2[0-3]):[0-5]\\d\\b',
    time_hms:'\\b(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\b',
    mark_time:'\\b\\d+:[0-5]\\d(?:[.,]\\d{3})?\\b',
    braces:'\\{[^{}]*\\}',brackets:'\\[[^\\[\\]]*\\]',parentheses:'\\([^()]*\\)',
    double_quotes:'"[^"\\r\\n]*"',single_quotes:"'[^'\\r\\n]*'"
  };
  if((rule.type||'literal')==='regex')return rule.keyword;
  if(patterns[rule.type])return patterns[rule.type];
  return rule.keyword ? rule.keyword.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') : '';
}

function applyColors(text) {
  const matches=[];
  settings.colors.forEach((rule,priority)=>{
    const pattern=colorRulePattern(rule);
    if(!pattern)return;
    try{
      const expression=new RegExp(pattern,'gi');
      for(const match of text.matchAll(expression)){
        if(!match[0])continue;
        matches.push({start:match.index,end:match.index+match[0].length,color:/^#[0-9a-f]{6}$/i.test(rule.color)?rule.color:'#ed5b20',priority});
      }
    }catch(_){ /* Invalid user regular expressions are ignored. */ }
  });
  matches.sort((a,b)=>a.start-b.start||a.priority-b.priority||b.end-a.end);
  let cursor=0,html='';
  for(const match of matches){
    if(match.start<cursor)continue;
    html+=escapeHtml(text.slice(cursor,match.start));
    html+=`<span class="keyword" style="color:${match.color}">${escapeHtml(text.slice(match.start,match.end))}</span>`;
    cursor=match.end;
  }
  return html+escapeHtml(text.slice(cursor));
}

function ruleMatches(rule, text) {
  const source = text.toLowerCase();
  const value = rule.text.toLowerCase();
  switch (rule.compare || rule.type) {
    case 'startsWith': return source.startsWith(value);
    case 'endsWith': return source.endsWith(value);
    case 'contains': case 'include': return source.includes(value);
    case 'notContains': case 'exclude': return !source.includes(value);
    case 'equals': return source === value;
    case 'notEquals': return source !== value;
    case 'wholeWord':
      try { return new RegExp(`\\b${rule.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(text); }
      catch (_) { return false; }
    case 'containsAny': return rule.text.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).some(item=>source.includes(item));
    case 'containsAll': return rule.text.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean).every(item=>source.includes(item));
    case 'isEmpty': return text.trim()==='';
    case 'notEmpty': return text.trim()!=='';
    case 'regex':
      try { return new RegExp(rule.text, 'i').test(text); }
      catch (_) { return false; }
    default: return true;
  }
}

function appendLine(text, elapsed=0, direction='rx') {
  const output = document.querySelector('#rx-output');
  output.querySelector('.empty-state')?.remove();
  const line = document.createElement('div');
  line.className = `rx-line ${direction}`;
  const stamp = settings.display.millis ? `<span class="time">[${String(elapsed).padStart(8,'0')} ms]</span>` : '';
  line.innerHTML = `${stamp}<span>${applyColors(formatReceivedText(text))}</span>`;
  output.append(line);
  while (output.children.length > 3000) output.firstElementChild.remove();
  if (settings.display.autoscroll) output.scrollTop = output.scrollHeight;
}

function consumeAutomatedEcho(text) {
  const count = automatedEchoes.get(text) || 0;
  if (!count) return false;
  if (count === 1) automatedEchoes.delete(text); else automatedEchoes.set(text,count-1);
  return true;
}

async function sendAutomated(text) {
  automatedEchoes.set(text,(automatedEchoes.get(text)||0)+1);
  setTimeout(()=>consumeAutomatedEcho(text),2000);
  const result = await api().send_serial(text,true,settings.transport.encoding,settings.transport.lineEnding);
  if (!result.ok) {
    consumeAutomatedEcho(text);
    toast(result.message,true);
  }
}

async function processReceived(message) {
  let showOriginal = true;
  const beforeLines = [], afterLines = [];
  const skipResponses = consumeAutomatedEcho(message.text);
  for (const rule of settings.filters.filter(item => item.enabled && (item.text || ['isEmpty','notEmpty'].includes(item.compare)))) {
    const matches = ruleMatches(rule,message.text);
    const operation = rule.operation || 'show';
    if (operation === 'show' && !matches) showOriginal=false;
    if (operation === 'hide' && matches) showOriginal=false;
    if (operation === 'response' && matches && rule.output && !skipResponses) await sendAutomated(rule.output);
    if (operation === 'print' && matches && rule.output) afterLines.push(rule.output);
    if (operation === 'replace' && matches) {
      showOriginal=false;
      if (rule.output) afterLines.push(rule.output);
    }
    if (operation === 'prefix' && matches && rule.output) beforeLines.push(rule.output);
    if (operation === 'suffix' && matches && rule.output) afterLines.push(rule.output);
  }
  beforeLines.forEach(text => appendLine(text,message.elapsed_ms,'generated'));
  if (showOriginal) appendLine(message.text,message.elapsed_ms);
  afterLines.forEach(text => appendLine(text,message.elapsed_ms,'generated'));
}

function formatReceivedText(text) {
  if (settings.display.raw) return text;
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return text;
    return Object.entries(value).map(([key, item]) => {
      const rendered = item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item);
      return `${key} : ${rendered}`;
    }).join('\n');
  } catch (_) {
    return text;
  }
}

function formatDuration(ms) {
  const hours = Math.floor(ms/3600000), minutes = Math.floor(ms/60000)%60, seconds = Math.floor(ms/1000)%60;
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}

function setConnectionState(state) {
  connected = state;
  document.querySelector('#connect-btn').disabled = state || connectionPending;
  document.querySelector('#disconnect-btn').disabled = !state || connectionPending;
  document.querySelectorAll('.connection-pane input, .connection-pane select, #refresh-ports').forEach(control => { control.disabled=state || connectionPending; });
  document.querySelector('#status-light').classList.toggle('online', state);
  document.querySelector('#connection-badge').classList.toggle('online', state);
  document.querySelector('#connection-badge b').textContent = state ? t('connected') : t('disconnected');
  document.querySelector('#top-status').textContent = state ? t('online') : t('standby');
  document.querySelector('#rail-state').textContent = state ? t('online').replace('SYS:','') : t('ready');
  const activePort = settings.serial.mode === 'emulate' ? settings.emulator.port : document.querySelector('#serial-port').value;
  document.querySelector('#top-port').textContent = state ? activePort : t('no_port');
  document.querySelector('#send-break').disabled=!state;
  document.querySelector('#config-break').disabled=!state;
  updateSignalControlAvailability();
}

function updateSignalControlAvailability(){
  const flow=settings.serial.mode==='emulate'?settings.emulator.flowControl:settings.serial.flowControl;
  document.querySelector('#live-rts').disabled=!connected||flow==='rtscts';
  document.querySelector('#live-dtr').disabled=!connected||flow==='dsrdtr';
  document.querySelectorAll('.signal-input').forEach(item=>item.classList.toggle('editable',connected&&settings.serial.mode==='emulate'));
}

function updateSignals(signals={}){
  if(connected)['rts','dtr'].forEach(name=>{document.querySelector(`#live-${name}`).checked=Boolean(signals[name]);});
  ['cts','dsr','dcd','ri'].forEach(name=>{document.querySelector(`#live-${name}`).classList.toggle('on',Boolean(signals[name]));});
}

async function refreshPorts(force=false) {
  if (!api() || connectionPending || (connected&&!force)) return;
  const select = document.querySelector('#serial-port');
  const current = select.value || settings.serial.port;
  const ports = await api().list_serial_ports();
  select.innerHTML = ports.length ? ports.map(port => {
    const usb = port.vid ? ` [${port.vid}:${port.pid}]` : '';
    return `<option value="${escapeHtml(port.device)}">${escapeHtml(port.device)} / ${escapeHtml(port.family)}${usb}</option>`;
  }).join('') : `<option value="">${escapeHtml(t('no_ports'))}</option>`;
  if (ports.some(port => port.device === current)) select.value = current;
}

function collectSettings() {
  const mode = document.querySelector('#use-emulator').checked ? 'emulate' : 'physical';
  settings.serial = {mode,port:document.querySelector('#serial-port').value,baudrate:Number(document.querySelector('#baudrate').value),bytesize:Number(document.querySelector('#bytesize').value),parity:document.querySelector('#parity').value,stopbits:Number(document.querySelector('#stopbits').value),flowControl:document.querySelector('#flow-control').value,rts:mode==='physical'?document.querySelector('#live-rts').checked:settings.serial.rts,dtr:mode==='physical'?document.querySelector('#live-dtr').checked:settings.serial.dtr};
  settings.emulator = {vid:document.querySelector('#emulator-vid').value.toUpperCase(),pid:document.querySelector('#emulator-pid').value.toUpperCase(),port:document.querySelector('#emulator-port').value,baudrate:Number(document.querySelector('#emulator-baudrate').value),bytesize:Number(document.querySelector('#emulator-bytesize').value),parity:document.querySelector('#emulator-parity').value,stopbits:Number(document.querySelector('#emulator-stopbits').value),flowControl:document.querySelector('#emulator-flow-control').value,rts:document.querySelector('#emulator-rts').checked,dtr:document.querySelector('#emulator-dtr').checked,cts:document.querySelector('#emulator-cts').checked,dsr:document.querySelector('#emulator-dsr').checked,dcd:document.querySelector('#emulator-dcd').checked,ri:document.querySelector('#emulator-ri').checked};
  settings.display = {echo:document.querySelector('#echo').checked,millis:document.querySelector('#millis').checked,autoscroll:document.querySelector('#autoscroll').checked,raw:document.querySelector('#raw').checked,saveReception:document.querySelector('#save-reception').checked};
  settings.logging = {directory:document.querySelector('#log-directory').value.trim(),filename:document.querySelector('#log-filename').value.trim()};
  settings.transport = {encoding:document.querySelector('#text-encoding').value,lineEnding:document.querySelector('#line-ending').value,rxConversion:document.querySelector('#rx-conversion').value,fileDelay:Number(document.querySelector('#sequence-delay').value)||0};
  document.querySelectorAll('.shortcut-row').forEach(row=>{settings.shortcuts[row.dataset.key]=row.querySelector('select').value;});
  settings.filters = [...document.querySelectorAll('#filter-list .form-row')].map(row => ({enabled:row.querySelector('[type=checkbox]').checked,compare:row.querySelector('.filter-compare').value,text:row.querySelector('.filter-input').value.trim(),operation:row.querySelector('.filter-operation').value,output:row.querySelector('.filter-output').value}));
  settings.buttons = [...document.querySelectorAll('#button-list .form-row')].map(row => ({name:row.querySelectorAll('[type=text]')[0].value.trim(),value:row.querySelectorAll('[type=text]')[1].value,color:row.querySelector('[type=color]').value,key:row.querySelector('.button-key').value})).filter(item => item.name);
  settings.colors = [...document.querySelectorAll('#color-list .form-row')].map(row => ({type:row.querySelector('.color-type').value,keyword:row.querySelector('[type=text]').value.trim(),color:row.querySelector('[type=color]').value})).filter(item => item.keyword || item.type!=='literal');
}

function populateSettings() {
  ['baudrate','bytesize','parity','stopbits'].forEach(key => { document.querySelector(`#${key}`).value = String(settings.serial[key]); });
  document.querySelector('#flow-control').value=settings.serial.flowControl;
  document.querySelector('#echo').checked = settings.display.echo;
  document.querySelector('#millis').checked = settings.display.millis;
  document.querySelector('#autoscroll').checked = settings.display.autoscroll;
  document.querySelector('#raw').checked = settings.display.raw;
  ['vid','pid','port','baudrate','bytesize','parity','stopbits'].forEach(key => { document.querySelector(`#emulator-${key}`).value = String(settings.emulator[key]); });
  document.querySelector('#emulator-flow-control').value=settings.emulator.flowControl;
  ['rts','dtr','cts','dsr','dcd','ri'].forEach(key=>{document.querySelector(`#emulator-${key}`).checked=Boolean(settings.emulator[key]);});
  document.querySelector('#live-rts').checked=Boolean(settings.serial.mode==='emulate'?settings.emulator.rts:settings.serial.rts);
  document.querySelector('#live-dtr').checked=Boolean(settings.serial.mode==='emulate'?settings.emulator.dtr:settings.serial.dtr);
  document.querySelector('#text-encoding').value=settings.transport.encoding;
  document.querySelector('#line-ending').value=settings.transport.lineEnding;
  document.querySelector('#rx-conversion').value=settings.transport.rxConversion;
  document.querySelector('#sequence-delay').value=settings.transport.fileDelay;
  const emulated = settings.serial.mode === 'emulate';
  document.querySelector('#use-physical').checked = !emulated;
  document.querySelector('#use-emulator').checked = emulated;
  showConnectionPane(emulated ? 'emulate' : 'physical');
  document.querySelector('#save-reception').checked = false;
  document.querySelector('#log-directory').value = settings.logging.directory;
  document.querySelector('#log-filename').value = settings.logging.filename;
  settings.display.saveReception = false;
  renderEditors(); renderQuickButtons(); renderColorPreview(); renderShortcuts();
}

const rowButton = () => '<button class="remove-row" title="Remove">×</button>';
function filterRow(item={enabled:true,compare:'contains',text:'',operation:'show',output:''}) {
  const comparisons = [['startsWith','starts_with'],['endsWith','ends_with'],['contains','contains'],['notContains','not_contains'],['equals','equals'],['notEquals','not_equals'],['wholeWord','whole_word'],['containsAny','contains_any'],['containsAll','contains_all'],['isEmpty','is_empty'],['notEmpty','is_not_empty'],['regex','regex']];
  const legacyCompare = {include:'contains',exclude:'notContains'};
  const savedCompare = item.compare || item.type || 'contains';
  const currentCompare = legacyCompare[savedCompare] || savedCompare;
  const compareOptions = comparisons.map(([value,key]) => `<option value="${value}" ${currentCompare===value?'selected':''}>${t(key)}</option>`).join('');
  const currentOperation = item.operation || 'show';
  const operationOptions = [['show','show'],['hide','do_not_show'],['response','response'],['print','print'],['replace','replace'],['prefix','prefix'],['suffix','suffix']].map(([value,key]) => `<option value="${value}" ${currentOperation===value?'selected':''}>${t(key)}</option>`).join('');
  return `<div class="form-row filter-cols"><label class="mini-check"><input type="checkbox" ${item.enabled?'checked':''}></label><select class="filter-compare">${compareOptions}</select><input class="filter-input" type="text" value="${escapeHtml(item.text)}" placeholder="${t('filter_placeholder')}"><select class="filter-operation">${operationOptions}</select><input class="filter-output" type="text" value="${escapeHtml(item.output||'')}" placeholder="${t('response_placeholder')}">${rowButton()}</div>`;
}
function buttonRow(item={name:'',value:'',color:'#ed5b20',key:'none'}) {
  const keys=[['none','NONE'],...Array.from({length:10},(_,number)=>[`Numpad${number}`,`NUM ${number}`]),['NumpadAdd','NUM +'],['NumpadSubtract','NUM -'],['NumpadMultiply','NUM *'],['NumpadDivide','NUM /'],['NumpadDecimal','NUM .'],['NumpadEnter','NUM ENTER']];
  const keyOptions=keys.map(([value,label])=>`<option value="${value}" ${item.key===value?'selected':''}>${label}</option>`).join('');
  return `<div class="form-row button-cols"><input type="text" value="${escapeHtml(item.name)}" placeholder="${t('button_name_placeholder')}"><input type="text" value="${escapeHtml(item.value)}" placeholder="${t('send_string_placeholder')}"><input type="color" value="${item.color}"><select class="button-key">${keyOptions}</select>${rowButton()}</div>`;
}
function colorRow(item={type:'literal',keyword:'',color:'#ed5b20'}) {
  const palette=[['#ed5b20','ORANGE'],['#ff5a4f','RED'],['#e4a83a','YELLOW'],['#54c47c','GREEN'],['#31b7bc','CYAN'],['#478ee8','BLUE'],['#875bd1','PURPLE'],['#dc65a2','PINK'],['#f2f2ee','WHITE'],['#8b9090','GRAY']];
  const types=[['literal','TEXT'],['date_dmy','DATE DD/MM/YYYY'],['date_ymd','DATE YYYY/MM/DD'],['time_hm','TIME HH:MM'],['time_hms','TIME HH:MM:SS'],['mark_time','MARK TIME MIN:SEC,MS'],['braces','CONTENT { }'],['brackets','CONTENT [ ]'],['parentheses','CONTENT ( )'],['double_quotes','CONTENT " "'],['single_quotes',"CONTENT ' '"],['regex','REGULAR EXPRESSION']];
  const typeOptions=types.map(([value,name])=>`<option value="${value}" ${(item.type||'literal')===value?'selected':''}>${escapeHtml(name)}</option>`).join('');
  const options=palette.map(([value,name])=>`<option value="${value}" ${item.color.toLowerCase()===value?'selected':''}>${name}</option>`).join('');
  return `<div class="form-row color-cols"><select class="color-type">${typeOptions}</select><input type="text" value="${escapeHtml(item.keyword)}" placeholder="${(item.type||'literal')==='literal'?t('keyword_placeholder'):t('optional_pattern')}"><div class="color-control"><input type="color" value="${item.color}"><select class="color-preset">${options}</select></div>${rowButton()}</div>`;
}
function renderEditors() {
  document.querySelector('#filter-list').innerHTML = settings.filters.map(filterRow).join('');
  document.querySelector('#button-list').innerHTML = settings.buttons.map(buttonRow).join('');
  document.querySelector('#color-list').innerHTML = settings.colors.map(colorRow).join('');
}
function renderQuickButtons() {
  document.querySelector('#quick-buttons').innerHTML = settings.buttons.map((button,index) => `<button class="quick-command" data-index="${index}" style="--button-color:${button.color}"><b>${escapeHtml(button.name)}</b><small>${escapeHtml(button.value)}</small>${button.key&&button.key!=='none'?`<em>${escapeHtml(button.key.replace('Numpad','NUM '))}</em>`:''}</button>`).join('') || '<div class="empty-state">NO BUTTONS</div>';
  document.querySelector('#button-count').textContent = String(settings.buttons.length).padStart(2,'0');
}
function renderColorPreview() {
  document.querySelector('#color-preview-list').innerHTML = settings.colors.map(rule => `<span class="color-chip" style="--chip-color:${rule.color}"><i></i>${escapeHtml(rule.keyword||String(rule.type).replaceAll('_',' ').toUpperCase())}</span>`).join('') || '<span class="panel-note">NO COLOR RULES</span>';
}

function renderShortcuts(){
  const actions=[['none','NONE'],['refresh_ports','REFRESH PORTS'],['fullscreen','FULLSCREEN'],['connect','CONNECT'],['disconnect','DISCONNECT'],['clear','CLEAR TERMINAL'],['break','SEND BREAK'],['send_file','SEND TXT FILE'],['overview','OPEN OVERVIEW'],['options','OPEN OPTIONS'],['config','OPEN CONFIG'],['settings','OPEN SETTINGS']];
  document.querySelector('#shortcut-list').innerHTML=Array.from({length:12},(_,index)=>{
    const key=`F${index+1}`,selected=settings.shortcuts[key]||'none';
    const options=actions.map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('');
    return `<label class="shortcut-row" data-key="${key}"><b>${key}</b><select>${options}</select></label>`;
  }).join('');
}

function normalizeSettings(saved={}){
  const shortcuts={...DEFAULTS.shortcuts,...(saved.shortcuts||{})};
  Object.keys(shortcuts).forEach(key=>{if(shortcuts[key]==='profiles')shortcuts[key]='settings';});
  const usedButtonKeys=new Set();
  const buttons=(saved.buttons||DEFAULTS.buttons).map(item=>{
    let key=item.key||'none';
    if(key!=='none'&&usedButtonKeys.has(key))key='none';
    if(key!=='none')usedButtonKeys.add(key);
    return {...item,key};
  });
  const colors=(saved.colors||DEFAULTS.colors).map(item=>({...item,type:item.type||'literal'}));
  return {...DEFAULTS,...saved,serial:{...DEFAULTS.serial,...(saved.serial||{})},emulator:{...DEFAULTS.emulator,...(saved.emulator||{})},display:{...DEFAULTS.display,...(saved.display||{})},transport:{...DEFAULTS.transport,...(saved.transport||{})},logging:{...DEFAULTS.logging,...(saved.logging||{})},shortcuts,buttons,colors};
}

async function refreshProfiles(){
  const profiles=await api().list_profiles();
  document.querySelector('#profile-list').innerHTML=profiles.map(profile=>`<div class="profile-item" data-file="${escapeHtml(profile.file)}"><span><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.modified)} / ${escapeHtml(profile.file)}</small></span><button data-profile-action="load">LOAD</button><button data-profile-action="delete">DELETE</button></div>`).join('')||'<div class="empty-state">NO PROFILES SAVED</div>';
}

async function executeShortcut(action){
  switch(action){
    case 'refresh_ports': await refreshPorts(true);toast(t('serial_ports_refreshed'));break;
    case 'fullscreen': api().window_action('fullscreen');break;
    case 'connect': document.querySelector('#connect-btn').click();break;
    case 'disconnect': document.querySelector('#disconnect-btn').click();break;
    case 'clear': document.querySelector('#clear-rx').click();break;
    case 'break': document.querySelector('#send-break').click();break;
    case 'send_file': document.querySelector('#open-txt-file').click();break;
    case 'overview':case 'options':case 'config':case 'settings':showView(action);break;
  }
}

async function saveAll() {
  collectSettings(); renderQuickButtons(); renderColorPreview();
  const result = api() ? await api().save_settings(settings) : {message:t('settings_saved')};
  toast(result.message);
}

async function sendText(text) {
  if (!text) return;
  if (!api()) return appendLine(text,0,'tx');
  const result = await api().send_serial(text,true,settings.transport.encoding,settings.transport.lineEnding);
  if (!result.ok) return toast(result.message,true);
  if (settings.display.echo) appendLine(text,Number(document.querySelector('#connection-time').dataset.ms||0),'tx');
  return true;
}

async function poll() {
  if (!api()) return;
  try {
    const result = await api().poll_serial();
    if (result.connected !== connected) setConnectionState(result.connected);
    updateSignals(result.signals);
    if(document.querySelector('#save-reception').checked && !result.logging){
      document.querySelector('#save-reception').checked=false;
      document.querySelector('#log-path').textContent=t('save_reception_help');
    }
    if(result.log_error)toast(result.log_error,true);
    document.querySelector('#connection-time').textContent = formatDuration(result.elapsed_ms);
    document.querySelector('#connection-time').dataset.ms = result.elapsed_ms;
    if (paused) {
      pendingMessages.push(...result.messages);
      if(pendingMessages.length>3000)pendingMessages.splice(0,pendingMessages.length-3000);
    }
    else for (const message of result.messages) await processReceived(message);
  } catch (_) { /* Window is closing. */ }
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click',()=>{showView(button.dataset.view);if(button.dataset.view==='settings')refreshProfiles();}));
document.querySelectorAll('.option-tab').forEach(button=>button.addEventListener('click',()=>showOptionPane(button.dataset.optionView)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click',()=>{
  showView(button.dataset.goto);
  if(button.dataset.optionTarget)showOptionPane(button.dataset.optionTarget);
}));
document.querySelectorAll('[data-window]').forEach(button => button.addEventListener('click',() => api()?.window_action(button.dataset.window)));
document.querySelectorAll('.connection-tab').forEach(button => button.addEventListener('click',() => showConnectionPane(button.dataset.connectionView)));
document.querySelector('#use-physical').addEventListener('change',event => {
  if (event.target.checked) document.querySelector('#use-emulator').checked=false;
});
document.querySelector('#use-emulator').addEventListener('change',event => {
  if (event.target.checked) document.querySelector('#use-physical').checked=false;
});
document.querySelector('#refresh-ports').addEventListener('click',refreshPorts);
document.querySelectorAll('#text-encoding,#rx-conversion').forEach(control=>control.addEventListener('change',async()=>{
  settings.transport.encoding=document.querySelector('#text-encoding').value;
  settings.transport.rxConversion=document.querySelector('#rx-conversion').value;
  await api().set_transport_options(settings.transport.encoding,settings.transport.rxConversion);
}));
document.querySelector('#line-ending').addEventListener('change',event=>{settings.transport.lineEnding=event.target.value;});
document.querySelector('#connect-btn').addEventListener('click',async() => {
  if(connected || connectionPending)return;
  collectSettings();
  let config;
  if(settings.serial.mode==='emulate'){
    if(!document.querySelector('#use-emulator').checked)return toast(t('physical_required'),true);
    config={...settings.emulator,mode:'emulate'};
  }else{
    if(!document.querySelector('#use-physical').checked)return toast(t('physical_required'),true);
    if(!settings.serial.port)return toast(t('select_port'),true);
    config=settings.serial;
  }
  connectionPending=true; setConnectionState(false);
  try{
    const result=await api().connect_serial(config);
    connectionPending=false; setConnectionState(result.ok); toast(result.message,!result.ok);
  }catch(error){
    connectionPending=false; setConnectionState(false); toast(String(error),true);
  }
});
document.querySelector('#disconnect-btn').addEventListener('click',async() => {
  if(!connected || connectionPending)return;
  connectionPending=true; setConnectionState(true);
  try{const result=await api().disconnect_serial();connectionPending=false;setConnectionState(false);toast(result.message);}
  catch(error){connectionPending=false;setConnectionState(true);toast(String(error),true);}
});
['rts','dtr'].forEach(name=>document.querySelector(`#live-${name}`).addEventListener('change',async event=>{
  const result=await api().set_signal_state(name,event.target.checked);
  if(!result.ok){event.target.checked=!event.target.checked;toast(result.message,true);}else updateSignals(result.signals);
}));
['cts','dsr','dcd','ri'].forEach(name=>document.querySelector(`#live-${name}`).parentElement.addEventListener('click',async event=>{
  if(!event.currentTarget.classList.contains('editable'))return;
  const value=!document.querySelector(`#live-${name}`).classList.contains('on');
  const result=await api().set_signal_state(name,value);
  if(!result.ok)toast(result.message,true);else updateSignals(result.signals);
}));
document.querySelector('#send-break').addEventListener('click',async()=>{const result=await api().send_break(.25);toast(result.message,!result.ok);});
document.querySelector('#config-break').addEventListener('click',()=>document.querySelector('#send-break').click());
document.querySelector('#send-btn').addEventListener('click',() => { const input=document.querySelector('#tx-input'); sendText(input.value); input.value=''; input.focus(); });
document.querySelector('#tx-input').addEventListener('keydown',event => { if(event.key==='Enter') document.querySelector('#send-btn').click(); });
document.querySelector('#clear-rx').addEventListener('click',() => { document.querySelector('#rx-output').innerHTML=`<div class="empty-state"><span>${t('buffer_cleared')}</span><span>${t('waiting_data')}</span></div>`; });
document.querySelector('#pause-rx').addEventListener('click',async event => { paused=!paused; event.currentTarget.textContent=paused?t('resume'):t('pause'); if(!paused){for(const message of pendingMessages)await processReceived(message);pendingMessages=[];} });
document.querySelector('#quick-buttons').addEventListener('click',event => { const button=event.target.closest('.quick-command');if(button)sendText(settings.buttons[Number(button.dataset.index)].value); });
document.querySelector('#add-filter').addEventListener('click',() => document.querySelector('#filter-list').insertAdjacentHTML('beforeend',filterRow()));
document.querySelector('#add-button').addEventListener('click',() => document.querySelector('#button-list').insertAdjacentHTML('beforeend',buttonRow()));
document.querySelector('#add-color').addEventListener('click',() => document.querySelector('#color-list').insertAdjacentHTML('beforeend',colorRow()));
document.querySelectorAll('.rows').forEach(list => list.addEventListener('click',event => event.target.closest('.remove-row')?.closest('.form-row').remove()));
document.querySelector('#button-list').addEventListener('change',event=>{
  if(!event.target.classList.contains('button-key')||event.target.value==='none')return;
  document.querySelectorAll('.button-key').forEach(select=>{if(select!==event.target&&select.value===event.target.value)select.value='none';});
});
document.querySelector('#color-list').addEventListener('change',event => {
  const row=event.target.closest('.form-row'); if(!row)return;
  const picker=row.querySelector('[type=color]'),preset=row.querySelector('.color-preset');
  if(event.target===preset)picker.value=preset.value;
  if(event.target===picker)preset.value=picker.value;
  if(event.target.classList.contains('color-type')){
    const input=row.querySelector('[type=text]');
    input.placeholder=event.target.value==='literal'?t('keyword_placeholder'):t('optional_pattern');
  }
});
document.querySelector('#save-options').addEventListener('click',saveAll);
document.querySelector('#save-config').addEventListener('click',saveAll);
document.querySelector('#save-reception').addEventListener('change',async event => {
  collectSettings();
  const result = await api().set_logging(event.target.checked,settings.logging.directory,settings.logging.filename);
  if (!result.ok) event.target.checked=false;
  document.querySelector('#log-path').textContent = result.enabled ? result.path : t('save_reception_help');
  toast(result.message,!result.ok);
});

const logModal=document.querySelector('#log-modal');
function setLogModal(open){logModal.classList.toggle('open',open);logModal.setAttribute('aria-hidden',String(!open));}
document.querySelector('#open-log-config').addEventListener('click',()=>setLogModal(true));
document.querySelector('#close-log-modal').addEventListener('click',()=>setLogModal(false));
document.querySelector('#cancel-log-config').addEventListener('click',()=>setLogModal(false));
document.querySelector('#save-log-config').addEventListener('click',async()=>{
  collectSettings();
  if(document.querySelector('#save-reception').checked){
    const result=await api().set_logging(true,settings.logging.directory,settings.logging.filename);
    if(!result.ok)return toast(result.message,true);
    document.querySelector('#log-path').textContent=result.path;
  }
  await api().save_settings(settings); setLogModal(false); toast(t('log_config_saved'));
});

document.querySelector('#create-profile').addEventListener('click',async()=>{
  collectSettings();
  const name=document.querySelector('#profile-name').value.trim();
  const result=await api().save_profile(name,settings);toast(result.message,!result.ok);
  if(result.ok){document.querySelector('#profile-name').value='';await refreshProfiles();}
});
document.querySelector('#profile-list').addEventListener('click',async event=>{
  const action=event.target.dataset.profileAction,row=event.target.closest('.profile-item');
  if(!action||!row)return;
  if(action==='load'){
    if(connected||connectionPending)return toast('Disconnect the serial port before loading a profile',true);
    const result=await api().load_profile(row.dataset.file);
    if(!result.ok)return toast(result.message,true);
    settings=normalizeSettings(result.settings);populateSettings();await refreshPorts();
    if(settings.serial.port)document.querySelector('#serial-port').value=settings.serial.port;
    await api().set_transport_options(settings.transport.encoding,settings.transport.rxConversion);
    await api().save_settings(settings);toast(`Profile ${result.name} loaded`);
  }else if(action==='delete'&&window.confirm('Delete this profile?')){
    const result=await api().delete_profile(row.dataset.file);toast(result.message,!result.ok);if(result.ok)await refreshProfiles();
  }
});
document.querySelector('#save-shortcuts').addEventListener('click',saveAll);

const fileModal=document.querySelector('#file-modal');
const setFileModal=open=>{fileModal.classList.toggle('open',open);fileModal.setAttribute('aria-hidden',String(!open));};
document.querySelector('#open-txt-file').addEventListener('click',async()=>{
  const result=await api().choose_text_file();
  if(!result.ok){if(!result.cancelled)toast(result.message,true);return;}
  sequenceLines=result.lines;sequenceCancelled=false;
  document.querySelector('#sequence-file-path').value=result.path;
  document.querySelector('#sequence-lines').textContent=String(result.lines.length);
  document.querySelector('#sequence-progress-bar').style.width='0%';
  document.querySelector('#sequence-status').textContent='READY';setFileModal(true);
});
async function cancelSequence(){sequenceCancelled=true;setFileModal(false);}
document.querySelector('#close-file-modal').addEventListener('click',cancelSequence);
document.querySelector('#cancel-sequence').addEventListener('click',cancelSequence);
document.querySelector('#start-sequence').addEventListener('click',async event=>{
  if(!connected)return toast('Connect a serial port before sending a file',true);
  event.currentTarget.disabled=true;sequenceCancelled=false;
  const delay=Math.max(0,Math.min(Number(document.querySelector('#sequence-delay').value)||0,60000));
  settings.transport.fileDelay=delay;
  for(let index=0;index<sequenceLines.length&&!sequenceCancelled;index++){
    const line=sequenceLines[index];
    const result=await api().send_serial(line,true,settings.transport.encoding,settings.transport.lineEnding);
    if(!result.ok){toast(result.message,true);break;}
    if(settings.display.echo)appendLine(line,Number(document.querySelector('#connection-time').dataset.ms||0),'tx');
    const progress=Math.round(((index+1)/Math.max(sequenceLines.length,1))*100);
    document.querySelector('#sequence-progress-bar').style.width=`${progress}%`;
    document.querySelector('#sequence-status').textContent=`${index+1} / ${sequenceLines.length}`;
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  }
  event.currentTarget.disabled=false;
  if(!sequenceCancelled){document.querySelector('#sequence-status').textContent='COMPLETED';toast('Text file sequence completed');}
});

document.addEventListener('keydown',event=>{
  if(/^F([1-9]|1[0-2])$/.test(event.key)){
    const action=settings.shortcuts[event.key]||'none';
    if(action==='none')return;
    event.preventDefault();executeShortcut(action);return;
  }
  if(!event.code.startsWith('Numpad')||event.target.matches('input,select,textarea'))return;
  const button=settings.buttons.find(item=>item.key===event.code);
  if(!button)return;
  event.preventDefault();sendText(button.value);
});

async function initialize() {
  const resources = await api().load_resources();
  language = resources.language || {};
  applyTheme(resources.theme); applyLanguage();
  const saved = await api().load_settings();
  settings=normalizeSettings(saved);
  if(!settings.logging.directory)settings.logging.directory=resources.paths?.default_log_dir||'';
  populateSettings(); await refreshPorts();
  if(settings.serial.port) document.querySelector('#serial-port').value=settings.serial.port;
  setConnectionState(false);
  await api().set_transport_options(settings.transport.encoding,settings.transport.rxConversion);
  await refreshProfiles();
  pollLoop();
}
async function pollLoop(){await poll();setTimeout(pollLoop,80);}
window.addEventListener('pywebviewready',initialize);
