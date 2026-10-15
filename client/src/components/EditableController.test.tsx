// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {EditableController} from './EditableController';
import {defaultLayout,layoutKey,serializeLayout} from '../layout';
it('sends Xbox A protocol, releases on pointer cancellation, and suppresses play while editing',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const div=document.createElement('div');document.body.append(div);
 const root=createRoot(div),send=vi.fn(),analog=vi.fn();
 act(()=>root.render(<EditableController playerId={1} sendInput={send} sendAnalog={analog}/>));
 const button=div.querySelector<HTMLButtonElement>('button[aria-label="A"]')!;
 button.setPointerCapture=vi.fn();
 function pointer(type:string){const e=new MouseEvent(type,{bubbles:true});Object.defineProperty(e,'pointerId',{value:7});act(()=>button.dispatchEvent(e));}
 pointer('pointerdown');expect(send).toHaveBeenLastCalledWith('B',1);
 pointer('pointercancel');expect(send).toHaveBeenLastCalledWith('B',0);
 act(()=>div.querySelector<HTMLButtonElement>('button[aria-label="Controller menu"]')!.click());
 const edit=Array.from(div.querySelectorAll('button')).find(b=>b.textContent==='Edit layout')!;
 act(()=>edit.click());send.mockClear();
 expect(div.querySelector('button[aria-label="A"]')).toBeNull();
 act(()=>div.querySelector<HTMLButtonElement>('button[aria-label="Move A"]')!.click());
 expect(send).not.toHaveBeenCalled();
 act(()=>root.unmount());div.remove();vi.unstubAllGlobals();
});
it('keeps a duplicated assignment held until both controls release',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const controls=defaultLayout.map(c=>c.id==='b'&&c.kind==='button'?{...c,action:'B' as const}:c);
 localStorage.setItem(layoutKey,serializeLayout(controls));
 const div=document.createElement('div');document.body.append(div);
 const root=createRoot(div),send=vi.fn();
 act(()=>root.render(<EditableController playerId={1} sendInput={send} sendAnalog={vi.fn()}/>));
 const buttons=div.querySelectorAll<HTMLButtonElement>('button[aria-label="A"]');
 function pointer(index:number,type:string){const button=buttons[index];button.setPointerCapture=vi.fn();const e=new MouseEvent(type,{bubbles:true});Object.defineProperty(e,'pointerId',{value:index+1});act(()=>button.dispatchEvent(e));}
 pointer(0,'pointerdown');pointer(1,'pointerdown');expect(send.mock.calls).toEqual([['B',1]]);
 pointer(0,'pointerup');expect(send.mock.calls).toEqual([['B',1]]);
 pointer(1,'pointerup');expect(send.mock.calls).toEqual([['B',1],['B',0]]);
 act(()=>root.unmount());div.remove();localStorage.clear();vi.unstubAllGlobals();
});

it('paints presses immediately and flushes the last stick movement without replaying after release',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.useFakeTimers();
 let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
 const div=document.createElement('div');document.body.append(div);const root=createRoot(div),send=vi.fn(),analog=vi.fn();
 act(()=>root.render(<EditableController playerId={1} sendInput={send} sendAnalog={analog}/>));
 const button=div.querySelector<HTMLButtonElement>('button[aria-label="A"]')!;
 const stick=div.querySelector<HTMLDivElement>('[aria-label="left stick"]')!;
 button.setPointerCapture=vi.fn();stick.setPointerCapture=vi.fn();
 vi.spyOn(stick,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:100,height:100,right:100,bottom:100,x:0,y:0,toJSON(){return {};}});
 function pointer(el:Element,type:string,x=50,y=50){const e=new MouseEvent(type,{bubbles:true,clientX:x,clientY:y});Object.defineProperty(e,'pointerId',{value:1});act(()=>el.dispatchEvent(e));}
 pointer(button,'pointerdown');expect(button.classList.contains('is-pressed')).toBe(true);expect(send).toHaveBeenLastCalledWith('B',1);
 pointer(button,'pointerup');expect(button.classList.contains('is-pressed')).toBe(false);
 pointer(stick,'pointerdown');expect(analog).toHaveBeenLastCalledWith('left',0,0);
 now=5;pointer(stick,'pointermove',66,50);expect(stick.querySelector<HTMLElement>('.stick-knob')!.style.transform).toContain('16px');
 now=16;act(()=>vi.advanceTimersByTime(16));expect(analog).toHaveBeenLastCalledWith('left',.5,0);
 now=20;pointer(stick,'pointermove',82,50);pointer(stick,'pointerup');expect(analog).toHaveBeenLastCalledWith('left',0,0);
 const count=analog.mock.calls.length;act(()=>vi.advanceTimersByTime(100));expect(analog).toHaveBeenCalledTimes(count);
 act(()=>root.unmount());div.remove();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();
});
