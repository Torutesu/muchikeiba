"""blender -b --factory-startup --python-exit-code 1 --python frontend/scripts/build-creative-materials.py"""
from pathlib import Path
import json,bpy
ROOT=Path(__file__).resolve().parents[1]/'public/creative/materials'
config=json.loads((ROOT/'pbr-palettes.json').read_text())
def linear(c):return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
created=[]
for entry in config['materials']:
 material=bpy.data.materials.new('MI_'+entry['id'].replace('-','_'));material.use_nodes=True;material.use_fake_user=True
 color=tuple(linear(int(entry['baseColor'][i:i+2],16)/255) for i in (1,3,5))+(1,)
 material.diffuse_color=color;shader=material.node_tree.nodes.get('Principled BSDF');shader.inputs['Base Color'].default_value=color
 shader.inputs['Roughness'].default_value=entry['roughness'];shader.inputs['Metallic'].default_value=entry['metallic']
 if 'Coat Weight' in shader.inputs:shader.inputs['Coat Weight'].default_value=entry['coatWeight']
 if entry['id'].startswith(('coat-','silk-')):
  noise=material.node_tree.nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=180 if entry['id'].startswith('coat-') else 110
  bump=material.node_tree.nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.06;bump.inputs['Distance'].default_value=.002
  material.node_tree.links.new(noise.outputs['Fac'],bump.inputs['Height']);material.node_tree.links.new(bump.outputs['Normal'],shader.inputs['Normal'])
 material.asset_mark();material.asset_data.description=entry['name']+' / Muchi Racing Club';material['source_id']=entry['id'];material['base_color_space']='sRGB input converted to linear';created.append(material)
bpy.data.libraries.write(str(ROOT/'club-materials.blend'),set(created),fake_user=True,compress=True)
with bpy.data.libraries.load(str(ROOT/'club-materials.blend'),link=False)as(source,target):
 assert len(source.materials)==17 and all(name.startswith('MI_')for name in source.materials)
print('Wrote and re-read',len(created),'reusable Blender materials')
