/**
 * The in-preview editing layer, injected into a simulation artifact at serve
 * time for staff who opened it with `?edit=1`. It never touches the network —
 * the sandbox forbids that — it only postMessages the parent editor:
 *
 * - `simulation-text-edit` `{ before, after }` when a run of on-screen text was
 *   double-clicked and changed.
 * - `simulation-formula-pick` `{ index }` when a rendered formula was
 *   double-clicked. LaTeX cannot be edited in place (KaTeX has already turned
 *   it into MathML and there is no KaTeX inside the sandbox), so the parent
 *   opens that formula in its own equation editor.
 *
 * It edits the clicked TEXT NODE rather than its element, so a sentence with
 * inline markup in it — the symbol legend under the formulas, every label with
 * a bolded symbol — is editable instead of silently inert. Hover outlines make
 * that reach visible; before this existed, an element you could edit and one
 * you could not looked exactly the same.
 *
 * Kept as a plain string of ES5-ish source: it is inlined into a document with
 * a `script-src 'unsafe-inline'` CSP and must not depend on the app bundle.
 */
export const SIMULATION_EDITOR_STYLE = `
.sim-edit-target{outline:2px dashed #2563eb;outline-offset:2px;cursor:text}
.sim-edit-target[data-sim-latex]{cursor:pointer;outline-style:solid}
.sim-edit-active{outline:2px solid #2563eb;outline-offset:2px;background:#eff6ff;color:#0f172a}
.sim-edit-hint{position:fixed;left:8px;bottom:8px;z-index:2147483647;font:500 12px/1.4 system-ui,-apple-system,sans-serif;background:#1e293b;color:#fff;padding:4px 8px;border-radius:4px;opacity:.85;pointer-events:none}
`;

const SCRIPT = `(function(){
if(window.__simEditorLayer)return;
window.__simEditorLayer=1;
var SKIP='script,style,svg,canvas,button,select,option,input,textarea,.sim-edit-hint';
var MAX=2000;
var marked=null;
function post(payload){try{parent.postMessage(payload,'*')}catch(e){}}
function formulaOf(node){
  var el=node&&node.nodeType===1?node:node&&node.parentElement;
  return el?el.closest('[data-sim-latex]'):null;
}
function textNodeAt(event){
  var node=null;
  if(document.caretPositionFromPoint){
    var pos=document.caretPositionFromPoint(event.clientX,event.clientY);
    node=pos?pos.offsetNode:null;
  }else if(document.caretRangeFromPoint){
    var range=document.caretRangeFromPoint(event.clientX,event.clientY);
    node=range?range.startContainer:null;
  }
  if(!node||node.nodeType!==3||!node.data.trim()){
    node=null;
    var target=event.target;
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
document.addEventListener('mousemove',function(e){
  var formula=formulaOf(e.target);
  if(formula){highlight(formula);return}
  var node=textNodeAt(e);
  highlight(node?node.parentElement:null);
},true);
document.addEventListener('mouseleave',function(){highlight(null)},true);
document.addEventListener('dblclick',function(e){
  var formula=formulaOf(e.target);
  if(formula){
    highlight(null);
    post({type:'simulation-formula-pick',index:Number(formula.getAttribute('data-sim-index'))});
    return;
  }
  var node=textNodeAt(e);
  if(!node)return;
  highlight(null);
  var raw=node.data;
  var lead=raw.match(/^\\s*/)[0];
  var tail=raw.slice(lead.length).match(/\\s*$/)[0];
  var before=raw.slice(lead.length,raw.length-tail.length);
  var host=document.createElement('span');
  host.className='sim-edit-active';
  host.setAttribute('contenteditable','plaintext-only');
  host.textContent=before;
  node.parentNode.replaceChild(host,node);
  if(!host.isContentEditable)host.setAttribute('contenteditable','true');
  host.focus();
  var selection=document.getSelection();
  if(selection){
    var range=document.createRange();
    range.selectNodeContents(host);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  host.addEventListener('keydown',function(event){
    if(event.key==='Enter'){event.preventDefault();host.blur()}
    else if(event.key==='Escape'){event.preventDefault();host.textContent=before;host.blur()}
  });
  host.addEventListener('blur',function(){
    var after=(host.textContent||'').trim();
    var kept=after&&after.length<=MAX?after:before;
    host.parentNode.replaceChild(document.createTextNode(lead+kept+tail),host);
    if(kept!==before)post({type:'simulation-text-edit',before:before,after:kept});
  },{once:true});
});
var hint=document.createElement('div');
hint.className='sim-edit-hint';
hint.textContent='Double-click any text or formula to edit it';
document.body.appendChild(hint);
})();`;

/** The `<style>` + `<script>` pair to append to a staff preview document. */
export function buildSimulationEditorLayer(): string {
  return `<style>${SIMULATION_EDITOR_STYLE}</style><script>${SCRIPT}</script>`;
}
