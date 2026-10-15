export const actions = {
    B: 'A', A: 'B', Y: 'X', X: 'Y', L: 'LB', R: 'RB', ZL: 'LT', ZR: 'RT',
    Minus: 'Back', Plus: 'Start', L3: 'L3', R3: 'R3',
    DPadUp: '↑', DPadDown: '↓', DPadLeft: '←', DPadRight: '→'
};
export type Action = keyof typeof actions;
type Position = { id: string; x: number; y: number; size: number };
export type Control = Position & ({ kind: 'button'; action: Action } | { kind: 'stick'; stick: 'left' | 'right' });
export function isAction(value: string): value is Action { return Object.prototype.hasOwnProperty.call(actions, value); }
export const defaultLayout: Control[] = [
    { id:'left',kind:'stick',stick:'left',x:18,y:45,size:34 },
    { id:'right',kind:'stick',stick:'right',x:65,y:73,size:30 },
    ...([
        ['a','B',88,72],['b','A',95,50],['x','Y',81,50],['y','X',88,28],
        ['lb','L',15,12],['lt','ZL',5,12],['rb','R',85,12],['rt','ZR',95,12],
        ['back','Minus',43,18],['start','Plus',57,18],['l3','L3',35,65],['r3','R3',73,88],
        ['up','DPadUp',12,68],['down','DPadDown',12,94],['west','DPadLeft',6,81],['east','DPadRight',18,81]
    ] satisfies [string,Action,number,number][]).map(([id,action,x,y]):Control=>({id,kind:'button',action,x,y,size:16}))
];
export const layoutKey='freejoy:editable-layout-v1';
export function parseLayout(value: unknown): Control[] {
    if (!value || typeof value!=='object' || !('version' in value) || value.version!==1 || !('controls' in value) || !Array.isArray(value.controls)) throw new Error('Choose a FreeJoy layout export.');
    if (value.controls.length!==defaultLayout.length) throw new Error('Layout is missing controls.');
    const seen=new Set<string>();
    return value.controls.map((item:unknown):Control=>{
        if(!item || typeof item!=='object' || !('id' in item) || typeof item.id!=='string' || seen.has(item.id)) throw new Error('Invalid control identity.');
        const original=defaultLayout.find(c=>c.id===item.id);
        if(!original || !('kind' in item) || item.kind!==original.kind) throw new Error('Unknown control.');
        seen.add(item.id);
        if(!('x' in item) || typeof item.x!=='number' || !Number.isFinite(item.x) || item.x<0 || item.x>100 ||
           !('y' in item) || typeof item.y!=='number' || !Number.isFinite(item.y) || item.y<0 || item.y>100 ||
           !('size' in item) || typeof item.size!=='number' || !Number.isFinite(item.size) || item.size<10 || item.size>55) throw new Error('Invalid control position or size.');
        const pos={id:item.id,x:item.x,y:item.y,size:item.size};
        if(item.kind==='button' && 'action' in item && typeof item.action==='string' && isAction(item.action)) return {...pos,kind:'button',action:item.action};
        if(item.kind==='stick' && original.kind==='stick') return {...pos,kind:'stick',stick:original.stick};
        throw new Error('Invalid button assignment.');
    });
}
export function serializeLayout(controls:Control[]):string {return JSON.stringify({version:1,controls},null,2);}
export function clampPosition(x:number,y:number,size:number,width:number,height:number){
    const half=size/2;
    return {x:Math.max(half,Math.min(width-half,x))/width*100,y:Math.max(half,Math.min(height-half,y))/height*100};
}

export type MoveMode='single'|'group';
export const controlGroups=[['up','down','west','east'],['a','b','x','y']];
export function moveIds(id:string,mode:MoveMode):string[]{return mode==='group'?(controlGroups.find(g=>g.includes(id))??[id]):[id];}
export function moveControls(layout:Control[],ids:string[],dx:number,dy:number,width:number,height:number):Control[]{
    if(width<=0||height<=0)return layout;
    const moving=layout.filter(c=>ids.includes(c.id));
    let minX=-Infinity,maxX=Infinity,minY=-Infinity,maxY=Infinity;
    for(const c of moving){const half=Math.max(36,Math.min(width,height)*c.size/100)/2;
        minX=Math.max(minX,half-c.x*width/100);maxX=Math.min(maxX,width-half-c.x*width/100);
        minY=Math.max(minY,half-c.y*height/100);maxY=Math.min(maxY,height-half-c.y*height/100);
    }
    const x=Math.max(minX,Math.min(maxX,dx)),y=Math.max(minY,Math.min(maxY,dy));
    return layout.map(c=>ids.includes(c.id)?{...c,x:c.x+x/width*100,y:c.y+y/height*100}:c);
}
export type SymbolStyle='xbox'|'playstation';
const psLabels:Record<Action,string>={...actions,B:'×',A:'○',Y:'□',X:'△',L:'L1',R:'R1',ZL:'L2',ZR:'R2',Plus:'Options',Minus:'Share'};
export function actionLabel(action:Action,style:SymbolStyle){return style==='playstation'?psLabels[action]:actions[action];}
