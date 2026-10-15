import {describe,it,expect} from 'vitest';
import {defaultLayout,parseLayout,serializeLayout,clampPosition} from './layout';
import {moveControls,moveIds,actionLabel} from './layout';
describe('portable controller layouts',()=>{
    it('round trips edits and assignments',()=>{
        const changed=defaultLayout.map(c=>({...c,x:45,y:60,size:22}));
        expect(parseLayout(JSON.parse(serializeLayout(changed)))).toEqual(changed);
    });
    it('rejects partial, duplicate, out-of-bounds and unrecognized imports',()=>{
        const make=()=>JSON.parse(serializeLayout(defaultLayout));
        const partial=make();partial.controls.pop();expect(()=>parseLayout(partial)).toThrow();
        const duplicate=make();duplicate.controls[1]=duplicate.controls[0];expect(()=>parseLayout(duplicate)).toThrow();
        const bounds=make();bounds.controls[0].size=999;expect(()=>parseLayout(bounds)).toThrow();
        const bad=make();bad.controls[2].action='PowerOff';expect(()=>parseLayout(bad)).toThrow();
    });
    it('keeps dragged controls inside the playable area',()=>{
        expect(clampPosition(-100,900,100,800,400)).toEqual({x:6.25,y:87.5});
    });
});

it('moves each four-button cluster together, preserving spacing and clamping at edges',()=>{
 for(const id of ['a','up']){
  const ids=moveIds(id,'group');expect(ids).toHaveLength(4);
  const moved=moveControls(defaultLayout,ids,-100,-20,844,390);
  const group=defaultLayout.filter(c=>ids.includes(c.id));
  for(const c of group){const next=moved.find(n=>n.id===c.id)!;
   expect(next.x-c.x).toBeCloseTo(moved.find(n=>n.id===group[0].id)!.x-group[0].x);
   expect(next.y-c.y).toBeCloseTo(moved.find(n=>n.id===group[0].id)!.y-group[0].y);
  }
  expect(moved.find(c=>c.id==='left')).toEqual(defaultLayout.find(c=>c.id==='left'));
  const edge=moveControls(defaultLayout,ids,10000,10000,844,390);
  for(const c of edge.filter(c=>ids.includes(c.id)))expect(c.x).toBeLessThan(100);
 }
});
it('moves a single button independently and maps PlayStation symbols by position',()=>{
 const moved=moveControls(defaultLayout,moveIds('a','single'),-50,-20,844,390);
 expect(moved.find(c=>c.id==='b')).toEqual(defaultLayout.find(c=>c.id==='b'));
 expect(actionLabel('B','playstation')).toBe('×');expect(actionLabel('A','playstation')).toBe('○');
 expect(actionLabel('X','playstation')).toBe('△');expect(actionLabel('Y','playstation')).toBe('□');
});
