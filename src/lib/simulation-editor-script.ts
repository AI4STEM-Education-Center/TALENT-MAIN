/**
 * The in-preview editing layer, injected into a simulation artifact at serve
 * time for staff who opened it with `?edit=1`.
 *
 * It is inert until the parent turns edit mode on, so opening a simulation to
 * read it behaves exactly as it does for a student. Turning the mode on and off
 * is a message rather than a reload, because reloading restarts the simulation
 * and a teacher would lose whatever state they were looking at.
 *
 * In edit mode a single click opens whatever was clicked:
 *
 * - a run of on-screen text becomes an inline editable box;
 * - a rendered formula becomes its LaTeX source, and hovering one raises a
 *   small toolbar to add a formula after it or remove it.
 *
 * Enter or clicking away commits, Escape reverts. Committing posts the edit to
 * the parent; the parent stages it and, for a formula, posts back the MathML to
 * paint over the LaTeX box (KaTeX lives in the app bundle, not in here).
 *
 * It edits the clicked TEXT NODE rather than its element, so a sentence with
 * inline markup in it — the symbol legend under the formulas, every label with
 * a bolded symbol — is editable instead of silently inert.
 *
 * Every edit reports the ORIGINAL wording it started from, never the last one,
 * so re-editing the same label replaces its staged patch instead of stacking a
 * second one that hunts for text the first already replaced.
 *
 * Kept as a plain string of ES5-ish source: it is inlined into a document with
 * a `script-src 'unsafe-inline'` CSP and must not depend on the app bundle.
 */
export const SIMULATION_EDITOR_STYLE = `
.sim-edit-on [data-sim-latex]{cursor:pointer}
.sim-edit-target{outline:2px dashed #2563eb;outline-offset:2px;cursor:text}
.sim-edit-target[data-sim-latex]{outline-style:solid}
.sim-edit-active{outline:2px solid #2563eb;outline-offset:2px;background:#eff6ff;color:#0f172a}
.sim-edit-latex{font:500 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.sim-edit-active:empty{display:inline-block;min-width:8em;min-height:1.2em}
.sim-edit-hint{position:fixed;left:8px;bottom:8px;z-index:2147483647;font:500 12px/1.4 system-ui,-apple-system,sans-serif;background:#1e293b;color:#fff;padding:4px 8px;border-radius:4px;pointer-events:none;opacity:.85}
.sim-edit-bar{position:fixed;z-index:2147483646;display:flex;gap:2px;padding-bottom:6px}
.sim-edit-bar button{font:600 12px/1 system-ui,-apple-system,sans-serif;background:#1e293b;color:#fff;border:0;border-radius:4px;padding:4px 7px;cursor:pointer}
.sim-edit-bar button:hover{background:#2563eb}
.sim-edit-bar button.sim-edit-del:hover{background:#dc2626}
.sim-edit-bar button:disabled{opacity:.5;cursor:default}
.sim-edit-bad{outline:2px solid #dc2626!important;background:#fef2f2!important}
`;

const SCRIPT = `(function(){
if(window.__simEditorLayer)return;
window.__simEditorLayer=1;
var SKIP='script,style,svg,canvas,button,select,option,input,textarea,.sim-edit-hint,.sim-edit-bar';
var MAX=2000;
var on=false;
var marked=null;
var active=null;
var hint=null;
var bar=null;
var barFor=null;
var barTimer=null;
var seq=0;
var pending={};
var textEdits=new WeakMap();
function post(payload){try{parent.postMessage(payload,'*')}catch(e){}}
function formulaOf(node){
  var el=node&&node.nodeType===1?node:node&&node.parentElement;
  return el?el.closest('[data-sim-latex]'):null;
}
function textNodeAt(event){
  var target=event.target;
  if(!target||!target.closest||target.closest(SKIP+',.sim-edit-active'))return null;
  var node=null;
  if(document.caretPositionFromPoint){
    var pos=document.caretPositionFromPoint(event.clientX,event.clientY);
    node=pos?pos.offsetNode:null;
  }else if(document.caretRangeFromPoint){
    var range=document.caretRangeFromPoint(event.clientX,event.clientY);
    node=range?range.startContainer:null;
  }
  if(!node||!target.contains(node)||node.nodeType!==3||!node.data.trim()){
    node=null;
    if(target&&target.nodeType===1){
      for(var i=0;i<target.childNodes.length;i++){
        var child=target.childNodes[i];
        if(child.nodeType===3&&child.data.trim()){node=child;break}
      }
    }
  }
  if(!node)return null;
  var host=node.parentElement;
  if(!host||!(host instanceof HTMLElement))return null;
  if(host.closest(SKIP))return null;
  if(host.isContentEditable)return null;
  if(node.data.trim().length>MAX)return null;
  return node;
}
function highlight(el){
  if(marked===el)return;
  if(marked)marked.classList.remove('sim-edit-target');
  marked=el;
  if(marked)marked.classList.add('sim-edit-target');
}
function keepBar(){clearTimeout(barTimer);barTimer=null}
function hideBar(){keepBar();if(bar){bar.remove();bar=null;barFor=null}}
function leaveBar(){if(!barTimer)barTimer=setTimeout(function(){hideBar();highlight(null)},200)}
function showBar(formula){
  keepBar();
  if(barFor===formula)return;
  hideBar();
  barFor=formula;
  bar=document.createElement('div');
  bar.className='sim-edit-bar';
  bar.setAttribute('role','toolbar');
  bar.setAttribute('aria-label','Formula actions');
  // Prevent pointer focus from closing an editor before the click arrives;
  // use click for the action so touch and keyboard activation work as well.
  bar.addEventListener('mousedown',function(e){e.preventDefault()});
  var add=document.createElement('button');
  add.type='button';
  add.textContent='+ formula';
  add.title='Add a formula after this one';
  add.disabled=document.querySelectorAll('[data-sim-latex]').length>=8;
  add.addEventListener('click',function(e){e.stopPropagation();finishActive();addAfter(formula)});
  var del=document.createElement('button');
  del.type='button';
  del.className='sim-edit-del';
  del.textContent='Remove';
  del.title='Remove this formula';
  del.disabled=document.querySelectorAll('[data-sim-latex]').length<2;
  del.addEventListener('click',function(e){e.stopPropagation();finishActive();removeFormula(formula)});
  bar.appendChild(add);
  bar.appendChild(del);
  document.body.appendChild(bar);
  var box=formula.getBoundingClientRect();
  var zoom=parseFloat(getComputedStyle(document.documentElement).zoom)||1;
  bar.style.left=Math.max(0,Math.min(box.left/zoom,window.innerWidth/zoom-bar.offsetWidth))+'px';
  bar.style.top=(box.top/zoom>=bar.offsetHeight?box.top/zoom-bar.offsetHeight:box.bottom/zoom)+'px';
}
function indexOf(formula){
  var raw=formula.getAttribute('data-sim-index');
  return raw===null?null:Number(raw);
}
function tokenOf(formula){
  var made=formula.getAttribute('data-sim-new');
  if(made)return made;
  var index=indexOf(formula);
  return index===null?null:'formula:'+index;
}
function removeCard(formula){
  var card=formula.parentElement?formula.parentElement.closest('div,li,figure,article,section,td,p,dd'):null;
  // Match the saved patch: remove the card only if it holds this formula alone.
  if(card&&card.querySelectorAll('[data-sim-latex]').length===1)card.remove();
  else formula.remove();
}
function removeFormula(formula){
  if(document.querySelectorAll('[data-sim-latex]').length<2)return;
  hideBar();
  highlight(null);
  var token=tokenOf(formula);
  if(!token)return;
  var made=formula.getAttribute('data-sim-new');
  if(made)post({type:'simulation-formula-drop',token:token});
  else post({type:'simulation-formula-delete',token:token,index:indexOf(formula)});
  removeCard(formula);
}
function addAfter(formula){
  if(document.querySelectorAll('[data-sim-latex]').length>=8)return;
  hideBar();
  var index=indexOf(formula);
  if(index===null)index=formula.getAttribute('data-sim-after');
  if(index===null)return;
  seq+=1;
  var made=document.createElement('span');
  made.setAttribute('data-sim-new','new:'+seq);
  made.setAttribute('data-sim-after',String(index));
  made.setAttribute('data-sim-latex','');
  made.setAttribute('data-sim-display',formula.getAttribute('data-sim-display')||'block');
  made.textContent='';
  // Mirror what the save does: clone the card the anchor formula lives in, so
  // the new one inherits its styling instead of landing loose beside it.
  var card=formula.parentElement?formula.parentElement.closest('div,li,figure,article,section,td,p,dd'):null;
  var slot=card?card.querySelector('[data-sim-latex]'):null;
  if(card&&slot&&card.parentNode){
    var clone=card.cloneNode(true);
    var inner=clone.querySelector('[data-sim-latex]');
    inner.parentNode.replaceChild(made,inner);
    card.parentNode.insertBefore(clone,card.nextSibling);
  }else{
    formula.parentNode.insertBefore(made,formula.nextSibling);
  }
  openLatex(made,'');
}
function finishActive(){if(active)active.commit()}
function openText(node){
  finishActive();
  var raw=node.data;
  var lead=raw.match(/^\\s*/)[0];
  var tail=raw.slice(lead.length).match(/\\s*$/)[0];
  var shown=raw.slice(lead.length,raw.length-tail.length);
  // A legend can contain several text runs in the SAME element. Keep identity
  // on the text node, and restore that node on close so later edits reuse it.
  var saved=textEdits.get(node);
  if(!saved){seq+=1;saved={original:shown,token:'text:'+seq};textEdits.set(node,saved)}
  var original=saved.original;
  var token=saved.token;
  var host=document.createElement('span');
  host.className='sim-edit-active';
  host.setAttribute('contenteditable','plaintext-only');
  host.textContent=shown;
  node.parentNode.replaceChild(host,node);
  if(!host.isContentEditable)host.setAttribute('contenteditable','true');
  select(host);
  var done=false;
  function close(keep){
    if(done)return;
    done=true;
    active=null;
    var after=(keep&&host.textContent?host.textContent.trim():shown);
    if(!after||after.length>MAX)after=shown;
    node.data=lead+after+tail;
    host.parentNode.replaceChild(node,host);
    document.dispatchEvent(new Event('sim-layout-change'));
    if(after===shown)return;
    if(after!==original)post({type:'simulation-text-edit',token:token,before:original,after:after});
    else post({type:'simulation-text-revert',token:token});
  }
  active={commit:function(){close(true)},cancel:function(){close(false)}};
  host.addEventListener('keydown',function(event){
    if(event.key==='Enter'){event.preventDefault();close(true)}
    else if(event.key==='Escape'){event.preventDefault();close(false)}
  });
  host.addEventListener('blur',function(){close(true)},{once:true});
}
function openLatex(formula,source){
  finishActive();
  hideBar();
  highlight(null);
  var token=tokenOf(formula);
  if(!token)return;
  var original=formula.getAttribute('data-sim-original-latex');
  if(original===null){original=source;formula.setAttribute('data-sim-original-latex',original)}
  var rendered=formula.innerHTML;
  formula.classList.add('sim-edit-active','sim-edit-latex');
  formula.setAttribute('contenteditable','plaintext-only');
  formula.textContent=source;
  if(!formula.isContentEditable)formula.setAttribute('contenteditable','true');
  select(formula);
  var done=false;
  function close(keep){
    if(done)return;
    done=true;
    active=null;
    var latex=(formula.textContent||'').trim();
    formula.removeAttribute('contenteditable');
    formula.classList.remove('sim-edit-active','sim-edit-latex');
    if(!keep||!latex||latex===source){
      // Nothing usable typed: put back exactly what was on screen before.
      if(!latex&&formula.getAttribute('data-sim-new')){
        post({type:'simulation-formula-drop',token:token});
        removeCard(formula);
        return;
      }
      formula.innerHTML=rendered;
      return;
    }
    formula.textContent=latex;
    var ticket='t'+(seq+=1);
    pending[ticket]={el:formula,fallback:rendered,source:source};
    post({
      type:formula.getAttribute('data-sim-new')?'simulation-formula-add':'simulation-formula-edit',
      token:token,
      ticket:ticket,
      index:indexOf(formula),
      after:Number(formula.getAttribute('data-sim-after')),
      display:formula.getAttribute('data-sim-display')||'block',
      latex:latex
    });
  }
  active={commit:function(){close(true)},cancel:function(){close(false)}};
  formula.addEventListener('keydown',function(event){
    if(event.key==='Enter'){event.preventDefault();close(true)}
    else if(event.key==='Escape'){event.preventDefault();close(false)}
  },{once:false});
  formula.addEventListener('blur',function(){close(true)},{once:true});
}
function select(el){
  el.focus();
  var selection=document.getSelection();
  if(!selection)return;
  var range=document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}
document.addEventListener('mousemove',function(e){
  if(!on)return;
  if(bar&&e.target&&e.target.closest&&e.target.closest('.sim-edit-bar')){keepBar();return}
  var formula=formulaOf(e.target);
  if(formula&&!formula.hasAttribute('contenteditable')){highlight(formula);showBar(formula);return}
  if(bar){leaveBar();return}
  var node=textNodeAt(e);
  highlight(node?node.parentElement:null);
},true);
document.addEventListener('mouseleave',function(e){
  // mouseleave is captured for every descendant, including the formula itself.
  // Only leaving the document should dismiss the toolbar immediately.
  if(on&&(e.target===document||e.target===document.documentElement)&&!e.relatedTarget){highlight(null);hideBar()}
},true);
document.addEventListener('scroll',hideBar,true);
document.addEventListener('click',function(e){
  if(!on)return;
  if(e.target&&e.target.closest&&e.target.closest('.sim-edit-bar'))return;
  var formula=formulaOf(e.target);
  if(formula){
    if(formula.hasAttribute('contenteditable'))return;
    e.preventDefault();
    e.stopPropagation();
    openLatex(formula,formula.getAttribute('data-sim-latex')||'');
    return;
  }
  var node=textNodeAt(e);
  if(!node)return;
  e.preventDefault();
  e.stopPropagation();
  highlight(null);
  openText(node);
},true);
window.addEventListener('message',function(event){
  var data=event.data;
  if(!data||event.source!==parent)return;
  if(data.type==='sim-edit-mode'){
    on=!!data.on;
    document.documentElement.classList.toggle('sim-edit-on',on);
    if(!on){
      if(active)active.cancel();
      highlight(null);
      hideBar();
      if(hint){hint.remove();hint=null}
    }else if(!hint){
      hint=document.createElement('div');
      hint.className='sim-edit-hint';
      hint.textContent='Click any text or formula to edit it — Enter to keep, Escape to undo';
      document.body.appendChild(hint);
    }
    return;
  }
  if(data.type==='sim-formula-painted'){
    var slot=pending[data.ticket];
    if(!slot)return;
    delete pending[data.ticket];
    if(data.html){
      slot.el.innerHTML=data.html;
      slot.el.classList.remove('sim-edit-bad');
      slot.el.setAttribute('data-sim-latex',data.latex);
    }else{
      // The parent could not render it; keep the source visible and flagged so
      // the teacher can fix it rather than discovering it at save time.
      slot.el.classList.add('sim-edit-bad','sim-edit-latex');
    }
  }
},false);
})();`;

/** The `<style>` + `<script>` pair to append to a staff preview document. */
export function buildSimulationEditorLayer(): string {
  return `<style>${SIMULATION_EDITOR_STYLE}</style><script>${SCRIPT}</script>`;
}
