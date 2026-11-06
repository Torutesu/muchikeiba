"""blender -b --python frontend/scripts/build-showroom.py
Build three inspectable GLBs and transparent reference renders from the anatomical source.
"""
import bpy, sys, importlib.util, math
sys.dont_write_bytecode=True
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('assets',ROOT/'unity/Assets/Art3D/build_asset_library.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
OUT=ROOT/'frontend/public';(OUT/'models').mkdir(parents=True,exist_ok=True)
for index,(hi,si) in enumerate([(0,0),(1,1),(2,2)]):
 a.clear();a.horse(a.HORSES[hi],a.SILKS[si]);a.jockey(a.SILKS[si])
 # Replace disconnected primitive silhouettes with a continuous, lean thoroughbred sculpt.
 coat=next(m for m in bpy.data.materials if m.name.startswith('Coat /'))
 for ob in list(bpy.context.scene.objects):
  if ob.name.startswith(('Dapple fleck','Ivory sock','Narrow forehead blaze')):bpy.data.objects.remove(ob,do_unlink=True)
 for ob in list(bpy.context.scene.objects):
  if ob.type=='MESH' and ob.data.materials and ob.data.materials[0]==coat:
   # A racehorse has a deep but narrow chest and a lighter barrel than the old toy model.
   if ob.name.startswith('Thoroughbred'):
    for v in ob.data.vertices:
     v.co.x*=.82;v.co.z=1.65+(v.co.z-1.65)*.73
     if v.co.y>.4:v.co.y=.4+(v.co.y-.4)*.45
   if ob.name.startswith('Arched'):
    for v in ob.data.vertices:v.co.x*=.8
  if ob.name.startswith(('Cheek plane','Eye socket','Expressive eye','Eye catchlight','Bridle brass','Nostril')):ob.location.x*=.86
  if ob.name.startswith('Refined head'):
   bpy.data.objects.remove(ob,do_unlink=True);continue
  if ob.type=='CURVE' and ob.name.startswith(('Flowing mane','Mane strand')):ob.data.bevel_depth*=.55
  if ob.name.startswith(('Jockey face','Forward sculpted nose')):ob.scale*=.82
  if ob.name.startswith('Helmet crown'):ob.scale*=.90
  if ob.name.endswith('polished hoof'):
   ob.scale.x*=.87;ob.scale.y*=.87;ob.scale.z*=.78
 for x,fy in [(-.29,.66),(.29,.46),(-.31,-.87),(.31,-.69)]:
  a.tapered_link('Connected anatomical pastern',(x,fy,.31),(x,fy+.025,.125),.042,.057,coat,'Horse','Body',24)
 a.loft_path('Sculpted long facial planes',[(.94,2.46,.105,.15),(1.08,2.36,.122,.17),(1.23,2.23,.104,.14),(1.43,2.06,.075,.11),(1.59,1.99,.07,.075)],coat,'Horse','Head',40)
 for side in (-1,1):a.ball('Integrated shoulder anatomy',(side*.25,.49,1.42),(.14,.20,.27),coat,'Horse','Body',32,20)
 a.ball('Refined pectoral bridge',(0,.54,1.30),(.24,.18,.24),coat,'Horse','Body',32,20)
 # A voxel union removes the neck/shoulder and cylinder joint seams in the original prototype.
 bpy.ops.object.select_all(action='DESELECT')
 skin=[]
 for ob in bpy.context.scene.objects:
  if ob.type=='MESH' and ob.data.materials and ob.data.materials[0]==coat:skin.append(ob);ob.select_set(True)
 bpy.context.view_layer.objects.active=skin[0];bpy.ops.object.convert(target='MESH');bpy.ops.object.join();sculpt=bpy.context.object
 sculpt.name='Continuous thoroughbred anatomical sculpt';sculpt.data.remesh_voxel_size=.014;bpy.ops.object.voxel_remesh()
 mod=sculpt.modifiers.new('Smooth muscles and tendons','SMOOTH');mod.factor=.75;mod.iterations=4;bpy.ops.object.modifier_apply(modifier=mod.name)
 a.smooth(sculpt)
 # Refined eye, leather and coat response; subtle micrograin instead of plastic specular.
 for m in bpy.data.materials:
  if not m.use_nodes:continue
  shader=m.node_tree.nodes.get('Principled BSDF')
  if shader and m.name.startswith('Coat /'):
   shader.inputs['Roughness'].default_value=.46
   shader.inputs['Specular IOR Level'].default_value=.28
   noise=m.node_tree.nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=190;noise.inputs['Detail'].default_value=2
   bump=m.node_tree.nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.08;bump.inputs['Distance'].default_value=.018
   m.node_tree.links.new(noise.outputs['Fac'],bump.inputs['Height']);m.node_tree.links.new(bump.outputs['Normal'],shader.inputs['Normal'])
 # Convert and merge by material for predictable browser draw calls, retaining real mesh detail.
 bpy.ops.object.select_all(action='DESELECT')
 for ob in bpy.context.scene.objects:
  if ob.type in ('MESH','CURVE'):ob.select_set(True)
 bpy.context.view_layer.objects.active=next(o for o in bpy.context.selected_objects if o.type=='MESH')
 bpy.ops.object.convert(target='MESH');buckets={}
 for ob in list(bpy.context.scene.objects):
  if ob.type=='MESH':buckets.setdefault(ob.data.materials[0].name if ob.data.materials else '',[]).append(ob)
 for group in buckets.values():
  bpy.ops.object.select_all(action='DESELECT')
  for ob in group:ob.select_set(True)
  bpy.context.view_layer.objects.active=group[0];bpy.ops.object.join()
  ob=bpy.context.object
  dec=ob.modifiers.new('Showroom mesh budget','DECIMATE');dec.ratio=.28 if 'Continuous thoroughbred' in ob.name else .58
  bpy.ops.object.modifier_apply(modifier=dec.name)
 bpy.ops.object.select_all(action='DESELECT')
 for ob in bpy.context.scene.objects:
  if ob.type=='MESH':ob.select_set(True)
 # Painted coat variation and markings replace the old raised sphere dapples.
 # Vertex colours survive GLB export, unlike an unbaked procedural shader.
 base=[(.12,.043,.018),(.30,.085,.025),(.42,.46,.47)][index]
 for ob in bpy.context.scene.objects:
  if ob.type!='MESH' or not ob.data.materials or ob.data.materials[0]!=coat:continue
  attr=ob.data.color_attributes.new(name='CoatColour',type='FLOAT_COLOR',domain='POINT')
  for v in ob.data.vertices:
   x,y,z=v.co;shade=.94+.06*math.sin(y*4+z*2);color=[c*shade for c in base]
   if index==2 and z>1.15:
    fleck=max(0,(math.sin(y*44+z*17)+math.sin(z*51+x*32)+math.sin(x*66-y*13)-1.65)/1.35)
    color=[c*(1-fleck*.38)+.70*fleck*.38 for c in color]
   if z<.65:color=[c*.4 for c in color]
   sock=(x<0 and y>.2) or (x>0 and y<-.45)
   if sock and .17<z<.39:color=[.76,.71,.59]
   if abs(x)<.021 and y>1.25 and 2.10<z<2.34 and index<2:color=[.77,.72,.61]
   attr.data[v.index].color=(*color,1)
  node=coat.node_tree.nodes.new('ShaderNodeVertexColor');node.layer_name='CoatColour'
  coat.node_tree.links.new(node.outputs['Color'],coat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
 # Skin the continuous mesh to a named armature, with blended knee and neck regions.
 rig=a.make_rig();old_action=rig.animation_data.action;rig.animation_data.action=None;bpy.data.actions.remove(old_action)
 for action in list(bpy.data.actions):
  if action.users==0:bpy.data.actions.remove(action)
 for bone in rig.pose.bones:bone.rotation_euler=(0,0,0);bone.location=(0,0,0)
 bpy.context.view_layer.update()
 for ob in [o for o in bpy.context.scene.objects if o.type=='MESH']:
  matrix=ob.matrix_world.copy();ob.parent=None;ob.matrix_world=matrix
  bpy.context.view_layer.objects.active=ob;ob.select_set(True);bpy.ops.object.transform_apply(location=True,rotation=True,scale=True);ob.select_set(False)
  groups={b.name:ob.vertex_groups.new(name=b.name) for b in rig.data.bones}
  for v in ob.data.vertices:
   x,y,z=v.co;weights={'Body':1.0}
   if z<1.23 and abs(x)>.14 and (y>.20 or y<-.45):
    pair='Front' if y>.2 else 'Hind';side='L' if x<0 else 'R';leg=pair+'_'+side
    lower=max(0,min(1,(.92-z)/.30));weights={leg+'_Upper':1-lower,leg+'_Lower':lower}
   elif y>.89 and z>1.78:weights={'Head':1.0}
   elif y>.32 and z>1.85:
    head=max(0,min(1,(y-.65)/.32));weights={'Neck':1-head,'Head':head}
   elif z>1.89 and y<.91:
    weights={'Jockey_Body':1.0} if z<2.52 else {'Jockey_Head':1.0}
   for name,weight in weights.items():
    if weight>0:groups[name].add([v.index],weight,'REPLACE')
  modifier=ob.modifiers.new('Deforming anatomical rig','ARMATURE');modifier.object=rig;ob.parent=rig
 action=bpy.data.actions.new('Gallop_Loop');rig.animation_data_create();rig.animation_data.action=action
 for frame in range(1,26,3):
  phase=(frame-1)/24*math.tau
  for leg,offset in [('Front_L',0),('Front_R',.65),('Hind_L',2.7),('Hind_R',3.35)]:
   for suffix in ('Upper','Lower'):
    bone=rig.pose.bones[leg+'_'+suffix];bone.rotation_mode='XYZ'
    bone.rotation_euler.x=(.48 if leg.startswith('Front') else .58)*math.sin(phase+offset) if suffix=='Upper' else -.12-.65*max(0,math.sin(phase+offset+.9))
    bone.keyframe_insert(data_path='rotation_euler',frame=frame)
  body=rig.pose.bones['Body'];body.rotation_mode='XYZ';body.rotation_euler.x=.025*math.sin(phase);body.location.z=.025*math.sin(phase*2);body.keyframe_insert(data_path='rotation_euler',frame=frame);body.keyframe_insert(data_path='location',frame=frame)
  rider=rig.pose.bones['Jockey_Body'];rider.rotation_mode='XYZ';rider.rotation_euler.x=.04*math.sin(phase*2+.4);rider.keyframe_insert(data_path='rotation_euler',frame=frame)
 for fc in action.fcurves:
  for key in fc.keyframe_points:key.interpolation='BEZIER'
 scene=bpy.context.scene;scene.frame_start=1;scene.frame_end=25;scene.render.fps=30
 # Export a neutral bind pose plus a real deforming gallop action.
 rig.animation_data.action=None
 for bone in rig.pose.bones:bone.rotation_euler=(0,0,0);bone.location=(0,0,0)
 rig.animation_data.action=action;scene.frame_set(1)
 bpy.ops.object.select_all(action='DESELECT')
 for ob in bpy.context.scene.objects:
  if ob.type in ('MESH','ARMATURE'):ob.select_set(True)
 bpy.ops.export_scene.gltf(filepath=str(OUT/'models'/f'partner-{index}.glb'),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_animations=True,export_frame_range=True,export_animation_mode='ACTIONS')
 rig.animation_data.action=None
 for bone in rig.pose.bones:bone.rotation_euler=(0,0,0);bone.location=(0,0,0)
 bpy.context.view_layer.update()
 scene=a.studio();scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=72;scene.cycles.use_denoising=False;scene.render.film_transparent=True;scene.render.resolution_x=1100;scene.render.resolution_y=900;scene.eevee.taa_render_samples=32
 scene.camera.data.ortho_scale=4.3;scene.camera.location=(5.4,3.4,2.8);scene.camera.rotation_euler=(Vector((0,0,1.38))-scene.camera.location).to_track_quat('-Z','Y').to_euler()
 # Transparent product image; actual lighting is warm-neutral, matching the club UI.
 for ob in list(scene.objects):
  if ob.get('non_export') and ob.type=='MESH':bpy.data.objects.remove(ob,do_unlink=True)
 scene.render.filepath=str(OUT/'art'/f'partner-{index}.png');bpy.ops.render.render(write_still=True)
 print('SHOWROOM_VARIANT_READY',index,flush=True)
