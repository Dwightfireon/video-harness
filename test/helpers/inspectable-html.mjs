/* Dispatch/cache fixtures still stop at a fake renderer, but must now present
 * real inspectable HTML to the real pre-render gate. No checker bypass. */
export function inspectableHtml(source) {
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#fff;color:#111}.scene{position:absolute;inset:0}.fixture-title{position:absolute;left:100px;top:200px;font:40px sans-serif}
    #subbox{position:absolute;left:200px;top:900px;max-width:1500px;font:36px sans-serif}
    </style><body><div id="subbox"></div><script>
    window.W=1920;window.H=1080;const __fixtureScenes=[];
    window.renderAt=t=>{for(const s of __fixtureScenes)s.el.style.display=t>=s.a&&t<s.b?'block':'none';document.querySelector('#subbox').textContent=typeof SUBS==='undefined'?'':SUBS.find(s=>t>=s.s&&t<s.e)?.t||'';};
    function addScene(a,b,build){const el=document.createElement('div');el.className='scene';el.innerHTML='<div class="fixture-title">Readable fixture</div>';document.body.appendChild(el);__fixtureScenes.push({a,b,el});}
    ${source}
    window.renderAt(0);
    </script>`;
}
