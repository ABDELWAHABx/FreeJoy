import {useEffect,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {actions,defaultLayout,layoutKey,parseLayout,serializeLayout,clampPosition,isAction,moveIds,moveControls,actionLabel} from '../layout';
import type {Control,Action,MoveMode,SymbolStyle} from '../layout';
import './editable-controller.css';

type Props={playerId:number;sendInput:(button:string,state:0|1)=>void;sendAnalog:(stick:'left'|'right',x:number,y:number)=>void};
function initialLayout(){try{const raw=localStorage.getItem(layoutKey);return raw?parseLayout(JSON.parse(raw)):defaultLayout;}catch{return defaultLayout;}}
export function EditableController(props:Props){
    const [layout,setLayout]=useState<Control[]>(initialLayout);
    const [editing,setEditing]=useState(false);
    const [menu,setMenu]=useState(false);
    const [toolsVisible,setToolsVisible]=useState(true);
    const [inputEpoch,setInputEpoch]=useState(0);
    const [moveMode,setMoveMode]=useState<MoveMode>('group');
    const [symbols,setSymbols]=useState<SymbolStyle>(()=>{try{return localStorage.getItem('freejoy:symbols')==='playstation'?'playstation':'xbox';}catch{return 'xbox';}});
    const label=(action:Action)=>actionLabel(action,symbols);
    const beginEdit=()=>{neutral();before.current=layout;setMenu(false);setEditing(true);setToolsVisible(true);setMessage('Drag controls. Choose Group or Individual.');};
    const fullscreen=()=>{setMenu(false);document.documentElement.requestFullscreen?.().catch(()=>{setMenu(true);setMessage('Fullscreen unavailable. Try opening in Chrome.');});};
    const [selected,setSelected]=useState('a');
    const [message,setMessage]=useState('');
    const [bounds,setBounds]=useState({width:800,height:350});
    const canvas=useRef<HTMLDivElement>(null),file=useRef<HTMLInputElement>(null);
    const drag=useRef<{pointer:number;id:string;startX:number;startY:number;layout:Control[];ids:string[]}|null>(null);
    const before=useRef(layout);
    const heldActions=useRef(new Map<string,number>());
    const latest=useRef(props);latest.current=props;
    const sendButton:Props['sendInput']=(action,state)=>{
        const previous=heldActions.current.get(action)??0;
        const next=state?previous+1:Math.max(0,previous-1);
        heldActions.current.set(action,next);
        if(previous===0&&next>0)latest.current.sendInput(action,1);
        if(previous>0&&next===0)latest.current.sendInput(action,0);
    };
    const neutral=()=>{setInputEpoch(n=>n+1);heldActions.current.clear();Object.keys(actions).forEach(a=>latest.current.sendInput(a,0));latest.current.sendAnalog('left',0,0);latest.current.sendAnalog('right',0,0);};
    useEffect(()=>{
        const el=canvas.current;if(!el)return;
        const measure=()=>{const width=el.clientWidth,height=el.clientHeight;if(width>0&&height>0)setBounds(old=>old.width===width&&old.height===height?old:{width,height});};
        measure();const observer=new ResizeObserver(measure);observer.observe(el);
        const hidden=()=>{if(document.hidden)neutral();};
        window.addEventListener('blur',neutral);document.addEventListener('visibilitychange',hidden);
        return()=>{observer.disconnect();window.removeEventListener('blur',neutral);document.removeEventListener('visibilitychange',hidden);neutral();};
    },[]);
    const chosen=layout.find(c=>c.id===selected);
    const update=(id:string,patch:Partial<Pick<Control,'x'|'y'|'size'>>)=>setLayout(old=>old.map(c=>c.id===id?{...c,...patch}:c));
    const pixels=(c:Control)=>Math.max(36,Math.min(bounds.width,bounds.height)*c.size/100);
    function save(){try{localStorage.setItem(layoutKey,serializeLayout(layout));setEditing(false);setMessage('Layout saved on this phone');}catch{setMessage('Storage unavailable. Export your layout to keep it.');}}
    function exportLayout(){const url=URL.createObjectURL(new Blob([serializeLayout(layout)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='FreeJoy-layout.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    function editDown(e:ReactPointerEvent<HTMLDivElement>,c:Control){
        if(!editing)return;e.preventDefault();setToolsVisible(false);setSelected(c.id);e.currentTarget.setPointerCapture(e.pointerId);
        drag.current={pointer:e.pointerId,id:c.id,startX:e.clientX,startY:e.clientY,layout,ids:moveIds(c.id,moveMode)};
    }
    function editMove(e:ReactPointerEvent<HTMLDivElement>,c:Control){
        const d=drag.current;if(!editing||!d||d.pointer!==e.pointerId||d.id!==c.id)return;
        setLayout(moveControls(d.layout,d.ids,e.clientX-d.startX,e.clientY-d.startY,bounds.width,bounds.height));
    }
    return <div className={'controller-workspace symbols-'+symbols+' '+(editing?'is-editing':'')}>
        {!editing&&<><button className="floating-menu" aria-label="Controller menu" onClick={()=>{neutral();setMenu(!menu);}}>⋯</button>
            {menu&&<section className="controller-menu" aria-label="Controller settings">
                <strong>Player {props.playerId}</strong><button onClick={beginEdit}>Edit layout</button><button onClick={fullscreen}>Fullscreen</button>
                <label>Phone symbols <select aria-label="Phone symbols" value={symbols} onChange={e=>{const value=e.target.value==='playstation'?'playstation':'xbox';setSymbols(value);try{localStorage.setItem('freejoy:symbols',value);}catch{setMessage('Symbols changed for this session only.');}}}><option value="xbox">Xbox · A B X Y</option><option value="playstation">PlayStation · × ○ □ △</option></select></label>
                <small>Phone symbols only. The laptop receives an Xbox controller.</small>
                <small>For an app shortcut, use your browser's Add to home screen. Fullscreen works without installation. App installation availability depends on your browser and a secure connection.</small>
                <span role="status">{message}</span><button onClick={()=>setMenu(false)}>Close menu</button>
            </section>}</>}
        {editing&&<button className="editor-tools-toggle" onClick={()=>setToolsVisible(!toolsVisible)}>{toolsVisible?'Hide tools':'Show tools'}</button>}
        {editing&&toolsVisible&&<header className="controller-toolbar"><strong>Edit layout</strong>
            <label>Move <select aria-label="Move controls" value={moveMode} onChange={e=>setMoveMode(e.target.value==='group'?'group':'single')}><option value="group">Group</option><option value="single">Individual</option></select></label>
            <span className="layout-message" role="status">{message}</span>
            <button onClick={save}>Save &amp; play</button><button onClick={()=>{setLayout(before.current);setEditing(false);setMessage('Changes discarded');}}>Cancel</button>
        </header>}
        <div ref={canvas} className="controller-canvas">
            {layout.map(c=>{
                const size=pixels(c),p=clampPosition(c.x*bounds.width/100,c.y*bounds.height/100,size,bounds.width,bounds.height);
                return <div key={c.id} className={'control-position '+(editing&&moveIds(selected,moveMode).includes(c.id)?'selected':'')} style={{left:p.x+'%',top:p.y+'%',width:size,height:size}}
                    data-control={c.id} onPointerDown={e=>editDown(e,c)} onPointerMove={e=>editMove(e,c)} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null}>
                    {editing?<button className="edit-hit" aria-label={'Move '+(c.kind==='button'?label(c.action):c.stick+' stick')} onClick={()=>setSelected(c.id)}>{c.kind==='button'?label(c.action):c.stick==='left'?'L stick':'R stick'}</button>:
                    c.kind==='button'?<PadButton key={inputEpoch} action={c.action} label={label(c.action)} send={sendButton}/>:<PadStick key={inputEpoch} stick={c.stick} send={props.sendAnalog}/>}
                </div>;
            })}
        </div>
        {editing&&toolsVisible&&<footer className="layout-tools">
            <label>Size <input aria-label="Control size" type="range" min="10" max="55" value={chosen?.size??16} onChange={e=>update(selected,{size:Number(e.target.value)})}/></label>
            {chosen?.kind==='button'&&<label>Button <select aria-label="Button assignment" value={chosen.action} onChange={e=>{const action=e.target.value;if(isAction(action))setLayout(old=>old.map(c=>c.id===selected&&c.kind==='button'?{...c,action}:c));}}>{Object.keys(actions).filter(isAction).map(a=><option key={a} value={a}>{actionLabel(a,symbols)}</option>)}</select></label>}
            <button onClick={exportLayout}>Export</button><button onClick={()=>file.current?.click()}>Import</button><button onClick={()=>{setLayout(defaultLayout);setMessage('Default restored. Save to keep it, or Cancel.');}}>Reset</button>
            <input ref={file} type="file" accept="application/json,.json" hidden onChange={async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{if(f.size>65536)throw new Error('Layout file is too large.');setLayout(parseLayout(JSON.parse(await f.text())));setMessage('Imported. Save to keep this layout.');}catch(error){setMessage(error instanceof Error?error.message:'Could not import layout.');}}}/>
        </footer>}
    </div>;
}
function PadButton({action,label,send}:{action:Action;label:string;send:Props['sendInput']}){
    const pointers=useRef(new Set<number>());
    const end=(e:ReactPointerEvent<HTMLButtonElement>)=>{
        if(pointers.current.delete(e.pointerId)&&pointers.current.size===0){send(action,0);e.currentTarget.classList.remove('is-pressed');}
    };
    return <button className={'pad-button action-'+actions[action]} aria-label={label} onPointerDown={e=>{
        e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('is-pressed');
        if(pointers.current.size===0)send(action,1);pointers.current.add(e.pointerId);
    }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>{label}</button>;
}
function PadStick({stick,send}:{stick:'left'|'right';send:Props['sendAnalog']}){
    const pointer=useRef<number|null>(null),knob=useRef<HTMLDivElement>(null);
    const geometry=useRef({x:0,y:0,radius:1});
    const pending=useRef<{x:number;y:number}|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),last=useRef(-Infinity);
    const latestSend=useRef(send);latestSend.current=send;
    const cancel=()=>{if(timer.current!==null)clearTimeout(timer.current);timer.current=null;pending.current=null;};
    const flush=()=>{timer.current=null;const p=pending.current;if(!p)return;pending.current=null;last.current=performance.now();latestSend.current(stick,p.x,p.y);};
    useEffect(()=>()=>{cancel();if(pointer.current!==null)latestSend.current(stick,0,0);},[stick]);
    const move=(e:ReactPointerEvent<HTMLDivElement>,force=false)=>{
        if(pointer.current!==e.pointerId)return;
        const {x:cx,y:cy,radius}=geometry.current;
        let x=(e.clientX-cx)/radius,y=(e.clientY-cy)/radius;const len=Math.hypot(x,y);if(len>1){x/=len;y/=len;}
        // Paint locally without a React render or a network round trip.
        if(knob.current)knob.current.style.transform=`translate3d(${x*radius}px,${y*radius}px,0)`;
        pending.current={x,y};const remaining=16-(performance.now()-last.current);
        if(force||remaining<=0){if(timer.current!==null)clearTimeout(timer.current);flush();}
        else if(timer.current===null)timer.current=setTimeout(flush,remaining);
    };
    const end=(e:ReactPointerEvent<HTMLDivElement>)=>{if(pointer.current===e.pointerId){
        pointer.current=null;cancel();e.currentTarget.classList.remove('is-held');
        if(knob.current)knob.current.style.transform='translate3d(0,0,0)';
        latestSend.current(stick,0,0);
    }};
    return <div className="pad-stick" role="slider" aria-label={stick+' stick'} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={0}
        onPointerDown={e=>{if(pointer.current!==null)return;e.preventDefault();const box=e.currentTarget.getBoundingClientRect();
            geometry.current={x:box.left+box.width/2,y:box.top+box.height/2,radius:box.width*.32};
            pointer.current=e.pointerId;e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.classList.add('is-held');move(e,true);
        }} onPointerMove={e=>move(e)} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
        <div ref={knob} className="stick-knob">{stick==='left'?'L':'R'}</div>
    </div>;
}
