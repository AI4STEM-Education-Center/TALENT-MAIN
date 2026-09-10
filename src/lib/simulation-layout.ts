/**
 * Fit existing generated artifacts as well as new ones. A taller dialog alone
 * cannot fix a formula row or control panel with its own scrollbar. On desktop
 * expand those panels, then use the largest scale that fits the entire frame.
 * The artifact stays in its sandbox and retains its DOM, controls and state.
 * Phone layouts keep their native, vertically scrolling presentation.
 */
export function buildSimulationLayoutLayer(): string {
  return `<script>(function(){
if(window.__simLayout)return;
window.__simLayout=1;
var root=document.documentElement;
var restored=[];
var scheduled=false;
var fitting=false;
var width=0;
var height=0;
var SKIP='script,style,svg,canvas,math,input,select,textarea,.sim-edit-bar,.sim-edit-hint,.sim-edit-active';
function reset(){
  restored.forEach(function(item){
    if(item.value)item.el.style.setProperty(item.name,item.value,item.priority);
    else item.el.style.removeProperty(item.name);
  });
  restored=[];
}
function remember(el,names){
  names.forEach(function(name){restored.push({el:el,name:name,value:el.style.getPropertyValue(name),priority:el.style.getPropertyPriority(name)})});
}
function apply(scale){
  root.style.setProperty('zoom',String(scale),'important');
  root.style.setProperty('width',(width/scale)+'px','important');
  root.style.setProperty('height',(height/scale)+'px','important');
}
function fits(elements){
  return elements.every(function(el){
    if(!el.clientWidth||!el.clientHeight)return true;
    // Inline text/MathML does not have meaningful client dimensions. Measure
    // its enclosing card instead, including overflow:hidden generated cards.
    var style=getComputedStyle(el);
    var frame=el===root||el===document.body;
    return ((!frame&&style.overflowX==='visible')||el.scrollWidth<=el.clientWidth+1)&&
      ((!frame&&style.overflowY==='visible')||el.scrollHeight<=el.clientHeight+1);
  });
}
function fit(){
  scheduled=false;
  if(document.querySelector('.sim-edit-active'))return;
  fitting=true;
  width=window.innerWidth;
  height=window.innerHeight;
  reset();
  if(width>=700&&height>0){
    remember(root,['zoom','width','height']);
    var elements=[root].concat(Array.from(document.body.querySelectorAll('*')).filter(function(el){
      return el instanceof HTMLElement&&!el.closest(SKIP);
    }));
    elements.unshift(document.body);
    // Fixed height caps keep overflowing even when more viewport space is
    // available. Expand only scroll panels, without touching the visual stage.
    elements.forEach(function(el){
      var style=getComputedStyle(el);
      if(el!==root&&el!==document.body&&/(auto|scroll)/.test(style.overflowY)){
        remember(el,['max-height','min-height']);
        el.style.setProperty('max-height','none','important');
        el.style.setProperty('min-height','min-content','important');
      }
    });
    apply(1);
    if(!fits(elements)){
      var low=0.25;
      var high=1;
      apply(low);
      if(fits(elements)){
        // A bounded search keeps the text as large as the document permits.
        for(var i=0;i<8;i++){
          var middle=(low+high)/2;
          apply(middle);
          if(fits(elements))low=middle;else high=middle;
        }
        apply(low);
      }else{
        // An artifact with an unresponsive fixed layout must stay accessible.
        // Keep its original scrolling behavior instead of clipping content.
        reset();
      }
    }
  }
  // Generated canvases commonly listen to window resize, not ResizeObserver.
  // Notify them after the final layout only; do not restart their simulation.
  window.dispatchEvent(new Event('resize'));
  fitting=false;
}
function schedule(){
  if(fitting||scheduled)return;
  scheduled=true;
  requestAnimationFrame(fit);
}
window.addEventListener('resize',function(){
  if(window.innerWidth!==width||window.innerHeight!==height)schedule();
});
// Only editor structure changes need another fit. Live readouts and animation
// updates must not cause a layout search on every frame.
document.addEventListener('focusout',schedule);
document.addEventListener('sim-layout-change',schedule);
document.addEventListener('click',function(e){if(e.target.closest&&e.target.closest('.sim-edit-bar'))schedule()},true);
window.addEventListener('message',function(e){
  if(e.source===parent&&e.data&&(e.data.type==='sim-formula-painted'||e.data.type==='sim-edit-mode'))schedule();
});
if(document.fonts)document.fonts.ready.then(schedule);else schedule();
})();</script>`;
}
