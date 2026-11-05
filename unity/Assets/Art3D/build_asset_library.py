import bpy, math, random, json
from mathutils import Vector
from pathlib import Path

ASSETS=Path(__file__).resolve().parents[1]
MODELS=ASSETS/'Resources'/'Models'
PARTNERS=MODELS/'Partners'; PARTNER_LODS=MODELS/'PartnerLODs'; MODULAR=MODELS/'Modular'; SOURCE=ASSETS/'Art3D'/'Source'
PREVIEWS=ASSETS/'Resources'/'Art'/'3DPreviews'
for p in (PARTNERS,PARTNER_LODS,MODULAR,SOURCE,PREVIEWS):p.mkdir(parents=True,exist_ok=True)

HORSES=[
('Bay','Kohaku',(.20,.075,.035,1),(.035,.021,.016,1),True,False),
('Chestnut','Akane',(.48,.13,.045,1),(.16,.047,.02,1),False,False),
('DappleGrey','Shiranami',(.50,.53,.53,1),(.10,.12,.15,1),False,True),
('Black','Yoru',(.035,.045,.055,1),(.015,.020,.027,1),False,False),
('Palomino','Kinako',(.68,.43,.17,1),(.83,.70,.43,1),True,False)]
SILKS=[
('Crimson','Crimson Laurel',(.62,.025,.055,1),(.94,.87,.70,1),(.83,.54,.14,1),'sash'),
('Azure','Azure Chevron',(.015,.18,.46,1),(.02,.68,.84,1),(.91,.91,.82,1),'chevron'),
('Violet','Violet Star',(.28,.07,.48,1),(.88,.85,.96,1),(.90,.63,.13,1),'star'),
('Emerald','Emerald Check',(.015,.31,.20,1),(.88,.82,.59,1),(.94,.92,.82,1),'check'),
('Gold','Midnight Gold',(.09,.12,.18,1),(.84,.53,.08,1),(.96,.87,.53,1),'band')]

def clear():
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes,bpy.data.curves,bpy.data.materials,bpy.data.cameras,bpy.data.lights,bpy.data.armatures):
        for d in list(coll):
            if not d.users:coll.remove(d)
def material(name,color,metal=0,rough=.34,coat=0):
    existing=bpy.data.materials.get(name)
    if existing:return existing
    m=bpy.data.materials.new(name);m.diffuse_color=color;m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=color;bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=rough
    if 'Coat Weight' in bs.inputs:bs.inputs['Coat Weight'].default_value=coat
    return m
def mark(o,group,bone='Root'):
    o['asset_group']=group;o['rig_bone']=bone;return o
def smooth(o):
    if o.type=='MESH':
        for f in o.data.polygons:f.use_smooth=True
    return o
def ball(name,loc,scale,mat,group,bone='Root',seg=28,rings=18):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg,ring_count=rings,radius=1,location=loc);o=bpy.context.object;o.name=name;o.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat);smooth(o);mark(o,group,bone);return o
def link(name,a,b,r,mat,group,bone='Root',n=18):
    a=Vector(a);b=Vector(b);d=b-a;bpy.ops.mesh.primitive_cylinder_add(vertices=n,radius=r,depth=d.length,location=(a+b)/2);o=bpy.context.object;o.name=name
    o.rotation_mode='QUATERNION';o.rotation_quaternion=Vector((0,0,1)).rotation_difference(d.normalized());o.data.materials.append(mat);smooth(o)
    be=o.modifiers.new('Rounded tailored edge','BEVEL');be.width=min(r*.25,.03);be.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');mark(o,group,bone);return o
def strand(name,points,r,mat,group,bone='Root'):
    c=bpy.data.curves.new(name,'CURVE');c.dimensions='3D';c.resolution_u=16;c.bevel_depth=r;c.bevel_resolution=3
    s=c.splines.new('BEZIER');s.bezier_points.add(len(points)-1)
    for bp,co in zip(s.bezier_points,points):bp.co=co;bp.handle_left_type='AUTO';bp.handle_right_type='AUTO'
    o=bpy.data.objects.new(name,c);bpy.context.collection.objects.link(o);o.data.materials.append(mat);mark(o,group,bone);return o
def fuse(name,parts,mat,group,bone,voxel=.028):
    objs=[ball(name+' volume',p,s,mat,group,bone,32,20) for p,s in parts]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:o.select_set(True)
    bpy.context.view_layer.objects.active=objs[0];bpy.ops.object.join();o=bpy.context.object;o.name=name;o.data.remesh_voxel_size=voxel;bpy.ops.object.voxel_remesh()
    sm=o.modifiers.new('Sculpt smoothing','SMOOTH');sm.factor=1.2;sm.iterations=4
    sub=o.modifiers.new('Silhouette polish','SUBSURF');sub.levels=1;sub.render_levels=1
    bpy.ops.object.modifier_apply(modifier=sm.name);bpy.ops.object.modifier_apply(modifier=sub.name);o.data.materials.clear();o.data.materials.append(mat);smooth(o);return mark(o,group,bone)
def loft_body(name,stations,mat,group,bone,radial=32):
    verts=[];faces=[]
    for y,z,rx,rz in stations:
        for i in range(radial):
            a=math.tau*i/radial;verts.append((rx*math.cos(a),y,z+rz*math.sin(a)))
    for r in range(len(stations)-1):
        for i in range(radial):
            a=r*radial+i;b=r*radial+(i+1)%radial;faces.append((a,b,b+radial,a+radial))
    verts.extend([(0,stations[0][0],stations[0][1]),(0,stations[-1][0],stations[-1][1])])
    first=len(verts)-2;last=first+1
    for i in range(radial):
        faces.append((first,(i+1)%radial,i));base=(len(stations)-1)*radial;faces.append((last,base+i,base+(i+1)%radial))
    mesh=bpy.data.meshes.new(name+' sculpt mesh');mesh.from_pydata(verts,[],faces);mesh.materials.append(mat);mesh.update()
    o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);mark(o,group,bone);smooth(o)
    sub=o.modifiers.new('Sculpted anatomical silhouette','SUBSURF');sub.levels=2;sub.render_levels=2
    return o
def loft_path(name,stations,mat,group,bone,radial=28):
    # stations are forward distance, height, horizontal radius, normal radius
    verts=[];faces=[]
    for i,(y,z,rx,rn) in enumerate(stations):
        prev=stations[max(0,i-1)];nxt=stations[min(len(stations)-1,i+1)]
        dy=nxt[0]-prev[0];dz=nxt[1]-prev[1];length=max(1e-5,math.hypot(dy,dz));ny=-dz/length;nz=dy/length
        for j in range(radial):
            a=math.tau*j/radial;sn=math.sin(a)
            verts.append((rx*math.cos(a),y+ny*rn*sn,z+nz*rn*sn))
    for r in range(len(stations)-1):
        for i in range(radial):
            a=r*radial+i;b=r*radial+(i+1)%radial;faces.append((a,b,b+radial,a+radial))
    verts.extend([(0,stations[0][0],stations[0][1]),(0,stations[-1][0],stations[-1][1])])
    first=len(verts)-2;last=first+1
    for i in range(radial):
        faces.append((first,i,(i+1)%radial));base=(len(stations)-1)*radial;faces.append((last,base+(i+1)%radial,base+i))
    mesh=bpy.data.meshes.new(name+' loft mesh');mesh.from_pydata(verts,[],faces);mesh.materials.append(mat);mesh.update()
    o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);mark(o,group,bone);smooth(o)
    sub=o.modifiers.new('Fine organic subdivision','SUBSURF');sub.levels=2;sub.render_levels=2
    return o
def tapered_link(name,a,b,r1,r2,mat,group,bone='Root',n=24):
    a=Vector(a);b=Vector(b);d=b-a;bpy.ops.mesh.primitive_cone_add(vertices=n,radius1=r1,radius2=r2,depth=d.length,location=(a+b)/2)
    o=bpy.context.object;o.name=name;o.rotation_mode='QUATERNION';o.rotation_quaternion=Vector((0,0,1)).rotation_difference(d.normalized());o.data.materials.append(mat);smooth(o)
    be=o.modifiers.new('Anatomical taper','BEVEL');be.width=min(r1,r2)*.20;be.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');return mark(o,group,bone)
def hoof(name,x,y,z,mat,group,bone):
    bpy.ops.mesh.primitive_cone_add(vertices=32,radius1=.108,radius2=.082,depth=.20,location=(x,y,z));o=bpy.context.object;o.name=name;o.scale.y=1.15;o.data.materials.append(mat);smooth(o)
    b=o.modifiers.new('Hoof bevel','BEVEL');b.width=.016;b.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');return mark(o,group,bone)

def saddlecloth(cfg,group,trim):
    silk=material('Woven silk / '+cfg[0],cfg[2],.02,.34);ink=material('Number embroidery / '+cfg[0],cfg[4],.58,.27)
    barrel=[(-1.44,1.46,.025,.05),(-1.31,1.49,.29,.38),(-1.08,1.52,.44,.55),(-.80,1.53,.48,.60),(-.54,1.52,.45,.58),(-.20,1.49,.40,.51),(.16,1.47,.39,.48),(.43,1.47,.42,.53),(.68,1.49,.38,.47),(.91,1.49,.23,.32),(1.01,1.49,.025,.05)]
    def surface(y,z):
        for a,b in zip(barrel,barrel[1:]):
            if a[0]<=y<=b[0]:
                t=(y-a[0])/(b[0]-a[0]);cy=a[1]+(b[1]-a[1])*t;rx=a[2]+(b[2]-a[2])*t;rz=a[3]+(b[3]-a[3])*t
                return rx*math.sqrt(max(.05,1-((z-cy)/rz)**2))+.018
        return .30
    for side in (-1,1):
        verts=[];faces=[];cols=11;rows=13
        for r in range(rows):
            t=r/(rows-1);z=1.92-.57*t;half=.31*(1-.20*t)
            for c in range(cols):
                u=c/(cols-1)*2-1;y=-.13+u*half;zz=z-.035*u*u;x=side*surface(y,zz);verts.append((x,y,zz))
        for r in range(rows-1):
            for c in range(cols-1):
                a=r*cols+c;faces.append((a,a+1,a+1+cols,a+cols))
        me=bpy.data.meshes.new('Draped embroidered cloth');me.from_pydata(verts,[],faces);me.materials.append(silk);me.update()
        o=bpy.data.objects.new('Saddlecloth / '+cfg[0],me);bpy.context.collection.objects.link(o);mark(o,group,'Body')
        so=o.modifiers.new('Textile thickness','SOLIDIFY');so.thickness=.018;be=o.modifiers.new('Soft hem','BEVEL');be.width=.015;be.segments=2
        edge=[verts[i] for i in (0,cols-1,(rows-1)*cols+cols-1,(rows-1)*cols)];strand('Hand-piped gold hem',edge+[edge[0]],.010,trim,group,'Body')
        px=side*surface(-.13,1.63);ball('Enamel racing number plate',(px,-.13,1.63),(.018,.115,.12),ink,group,'Body',24,16)
        ball('Silk crest',(px+side*.018,-.13,1.64),(.012,.044,.044),material('Crest dark thread',(.07,.08,.10,1)),group,'Body',16,10)

def jockey(cfg):
    id_,name,primary,accent,trim,pattern=cfg;g='Rider'
    suit=material('Racing silk / '+id_,primary,.02,.32,.18);secondary=material('Woven pattern / '+id_,accent,.02,.38)
    gold=material('Trim / '+id_,trim,.68,.25);breech=material('Sand riding breeches',(.66,.59,.48,1),0,.55)
    boot=material('Polished riding boots',(.035,.045,.055,1),.18,.24,.32);glove=material('Leather gloves',(.09,.052,.029,1),.08,.33)
    skin=material('Jockey skin',(.63,.38,.26,1),0,.48);helmet=material('Helmet / '+id_,primary,.08,.22,.34)
    uv=ball
    ball('Rider pelvis',(0,-.05,2.02),(.16,.22,.13),breech,g,'Jockey_Body')
    loft_path('Tailored forward racing jersey',[(.02,2.04,.14,.16),(.13,2.14,.19,.21),(.27,2.30,.19,.22),(.39,2.43,.145,.16)],suit,g,'Jockey_Body',32)
    strand('Jersey center seam',[(0,.12,2.12),(0,.28,2.30),(0,.40,2.44)],.010,gold,g,'Jockey_Body')
    if pattern=='sash':strand('Cross-body silk sash',[(-.18,.48,2.52),(0,.50,2.42),(.18,.44,2.30)],.055,secondary,g,'Jockey_Body')
    elif pattern=='chevron':
        for z in (2.48,2.33):strand('Chevron silk',[(-.20,.42,z+.08),(0,.52,z),(.20,.42,z+.08)],.035,secondary,g,'Jockey_Body')
    elif pattern=='star':
        for x,y,z in [(-.15,.47,2.48),(.14,.47,2.45),(-.10,.45,2.26),(.13,.44,2.25)]:ball('Gold star embroidery',(x,y,z),(.022,.022,.047),gold,g,'Jockey_Body',12,8)
    elif pattern=='check':
        for z in (2.50,2.40,2.30):strand('Check stripe',[(-.20,.43,z),(.20,.43,z)],.018,secondary,g,'Jockey_Body')
    else:strand('Gold chest band',[(-.20,.46,2.39),(0,.51,2.39),(.20,.46,2.39)],.055,secondary,g,'Jockey_Body')
    for side in (-1,1):
        arm='Jockey_Arm_'+('L' if side<0 else 'R')
        ball('Jockey shoulder',(side*.19,.38,2.41),(.105,.15,.13),suit,g,'Jockey_Body',24,16)
        link('Silk sleeve upper',(side*.21,.40,2.41),(side*.28,.62,2.27),.082,suit,g,arm)
        ball('Jockey elbow',(side*.28,.62,2.27),(.074,.08,.078),suit,g,arm,20,12)
        link('Silk forearm',(side*.28,.62,2.27),(side*.24,.87,2.12),.064,suit,g,arm)
        ball('Rein glove',(side*.24,.89,2.10),(.066,.07,.064),glove,g,arm,20,12)
        tapered_link('Riding breeches / thigh',(side*.21,-.16,2.01),(side*.30,.05,1.78),.13,.082,breech,g,'Jockey_Body')
        ball('Breeches knee',(side*.30,.05,1.78),(.072,.078,.075),breech,g,'Jockey_Body',20,12)
        tapered_link('Riding boot shaft',(side*.32,.05,1.77),(side*.35,.02,1.48),.075,.058,boot,g,'Jockey_Body')
        ball('Boot toe',(side*.35,.11,1.47),(.085,.13,.068),boot,g,'Jockey_Body',20,12)
    ball('Jockey neck',(0,.43,2.48),(.085,.11,.13),skin,g,'Jockey_Head',20,12)
    ball('Jockey face',(0,.50,2.61),(.135,.16,.16),skin,g,'Jockey_Head',28,18)
    ball('Forward sculpted nose',(0,.655,2.59),(.045,.065,.045),skin,g,'Jockey_Head',20,12)
    for side in (-1,1):ball('Jockey eye',(side*.094,.60,2.64),(.018,.026,.018),boot,g,'Jockey_Head',16,10)
    ball('Helmet crown',(0,.50,2.77),(.175,.205,.125),helmet,g,'Jockey_Head',32,20)
    ball('Helmet silk panel',(0,.68,2.775),(.075,.02,.080),secondary,g,'Jockey_Head',20,12)
    strand('Helmet peak',[(-.17,.64,2.74),(0,.76,2.72),(.17,.64,2.74)],.018,gold,g,'Jockey_Head')
    lens=material('Smoke-blue goggle glass',(.06,.16,.20,1),.45,.15,.35)
    for side in (-1,1):
        ball('Racing goggle lens',(side*.10,.69,2.68),(.075,.035,.047),lens,g,'Jockey_Head',20,12)
        strand('Goggle frame',[(side*.18,.69,2.68),(side*.10,.72,2.68),(0,.73,2.68)],.013,gold,g,'Jockey_Head')
    strand('Helmet chin strap',[(-.13,.55,2.66),(-.12,.48,2.55),(0,.45,2.52),(.12,.48,2.55),(.13,.55,2.66)],.012,boot,g,'Jockey_Head')
    ball('Jersey number patch',(0,-.08,2.34),(.10,.018,.095),secondary,g,'Jockey_Body',20,12)

def horse(cfg,silk_cfg):
    id_,name,coatcolor,manecolor,socks,dapple=cfg;g='Horse'
    coat=material('Coat / '+id_,coatcolor,0,.46,.02);mane=material('Mane / '+id_,manecolor,0,.52)
    coatShader=coat.node_tree.nodes.get('Principled BSDF')
    if coatShader and 'Specular IOR Level' in coatShader.inputs:coatShader.inputs['Specular IOR Level'].default_value=.28
    dark=material('Muzzle and hooves',(.065,.045,.035,1),0,.34);leather=material('Oiled racing leather',(.09,.036,.018,1),.12,.28,.18)
    brass=material('Brushed brass',(.58,.34,.09,1),.78,.23);ivory=material('Warm ivory markings',(.90,.84,.72,1),0,.55);eye=material('Glossy eye',(.008,.012,.018,1),.08,.11,.6)
    loft_body('Thoroughbred barrel and hindquarter',[
      (-1.44,1.46,.025,.05),(-1.31,1.49,.29,.38),(-1.08,1.52,.44,.51),(-.80,1.53,.48,.54),
      (-.54,1.52,.45,.51),(-.20,1.49,.40,.46),(.16,1.47,.39,.44),(.43,1.47,.42,.49),
      (.68,1.49,.38,.44),(.91,1.49,.23,.30),(1.01,1.49,.025,.05)],coat,g,'Body')
    loft_path('Arched thoroughbred neck',[(.40,1.58,.29,.30),(.53,1.78,.32,.40),(.69,2.03,.285,.38),(.87,2.27,.225,.30),(1.05,2.43,.16,.21)],coat,g,'Neck')
    loft_path('Refined head and muzzle',[(.96,2.44,.16,.20),(1.13,2.34,.18,.23),(1.29,2.20,.16,.21),(1.45,2.06,.13,.17),(1.58,1.98,.095,.12)],coat,g,'Head')
    for side in (-1,1):
        ball('Cheek plane',(side*.135,1.18,2.18),(.090,.145,.125),coat,g,'Head',24,16)
        ball('Eye socket',(side*.153,1.18,2.35),(.026,.052,.034),dark,g,'Head',24,12)
        ball('Expressive eye',(side*.173,1.19,2.355),(.014,.032,.022),eye,g,'Head',24,12)
        ball('Eye catchlight',(side*.185,1.205,2.365),(.006,.009,.007),ivory,g,'Head',12,8)
        ball('Nostril',(side*.084,1.59,1.985),(.018,.036,.014),dark,g,'Head',16,10)
        tapered_link('Alert tapered ear',(side*.085,1.03,2.45),(side*.10,.96,2.68),.050,.012,mane,g,'Head',20)
        ball('Ear inner',(side*.088,.994,2.57),(.012,.028,.07),dark,g,'Head',16,10)
    if id_ in ('Bay','Chestnut','Palomino'):
        ball('Narrow forehead blaze',(0,1.37,2.19),(.014,.040,.14),ivory,g,'Head')
    legs=[('Front_L',-.29,.53,1.36,.63,.78,.66,.31),('Front_R',.29,.53,1.36,.48,.78,.46,.31),('Hind_L',-.31,-.77,1.42,-.98,.74,-.87,.31),('Hind_R',.31,-.77,1.42,-.58,.74,-.69,.31)]
    for name,x,hy,hz,ky,kz,fy,fz in legs:
        upper=name+'_Upper';lower=name+'_Lower'
        if name.startswith('Hind'):
            ball('Sculpted hindquarter muscle',(x,hy-.05,1.36),(.135,.22,.265),coat,g,'Body',28,18)
        tapered_link(name+' upper leg',(x,hy,hz),(x,ky,kz),.128 if name.startswith('Hind') else .108,.064,coat,g,upper)
        ball(name+' knee',(x,ky,kz),(.061,.068,.070),coat,g,upper,20,12)
        tapered_link(name+' cannon bone',(x,ky,kz),(x,fy,fz),.058,.035,coat,g,lower)
        tapered_link(name+' tendon',(x+(-.022 if x<0 else .022),ky,kz-.015),(x+(-.018 if x<0 else .018),fy,fz+.015),.024,.015,mane,g,lower,14)
        ball(name+' fetlock',(x,fy,fz),(.058,.070,.065),coat,g,lower,20,12);hoof(name+' polished hoof',x,fy,.10,dark,g,lower)
        if socks and name in ('Front_L','Hind_R'):ball('Ivory sock',(x,fy-.004,.34),(.056,.065,.085),ivory,g,lower,20,12)
    strand('Flowing mane crest',[(0,1.00,2.56),(0,.82,2.47),(0,.63,2.33),(0,.42,2.17),(0,.18,1.98)],.070,mane,g,'Neck')
    for i in range(7):
        x=(i-3)*.034;strand('Mane strand %02d'%i,[(x,1.00,2.56),(x*1.1,.80,2.46),(x*1.2,.57,2.29),(x*1.1,.32,2.10)],.014+(i%2)*.003,mane,g,'Neck')
    strand('Tail plume',[(0,-1.12,1.72),(0,-1.37,1.53),(0,-1.50,1.20),(0,-1.40,.78),(0,-1.26,.56)],.084,mane,g,'Tail')
    for i in range(8):
        x=(i-3.5)*.026;strand('Tail strand %02d'%i,[(x,-1.16,1.70),(x*1.2,-1.42,1.45),(x*1.5,-1.48,1.1),(x*1.35,-1.31,.65)],.012,mane,g,'Tail')
    if dapple:
        dap=material('Soft silver dapples',(.72,.73,.70,1),0,.58);random.seed(14)
        for side in (-1,1):
            for i in range(36):
                y=random.uniform(-.94,.78);z=random.uniform(1.28,1.86);x=side*(.44*math.sqrt(max(.08,1-((y+.03)/1.08)**2))*math.sqrt(max(.12,1-((z-1.49)/.58)**2))+.006)
                ball('Dapple fleck',(x,y,z),(random.uniform(.018,.032),.034,random.uniform(.012,.022)),dap,g,'Body',12,8)
    saddle=material('Hand-stitched saddle',(.07,.028,.016,1),.08,.26,.2)
    ball('English saddle',(0,-.06,1.96),(.32,.45,.14),saddle,g,'Body',32,18);ball('Saddle pommel',(0,.24,2.02),(.20,.13,.08),saddle,g,'Body',24,12)
    strand('Saddle girth',[(0,.15,1.88),(.25,.10,1.72),(.31,-.02,1.52),(.25,-.14,1.72),(0,-.19,1.87)],.035,saddle,g,'Body')
    for side in (-1,1):
        strand('Polished stirrup',[(side*.34,-.03,1.66),(side*.43,-.04,1.62),(side*.43,-.04,1.38),(side*.33,-.04,1.38),(side*.33,-.04,1.63)],.018,brass,g,'Body')
        link('Stirrup leather',(side*.28,-.05,1.91),(side*.38,-.04,1.63),.022,saddle,g,'Body',12)
        strand('Bridle cheek strap',[(side*.18,.88,2.48),(side*.235,.98,2.34),(side*.20,1.22,2.13),(side*.15,1.46,2.04)],.022,saddle,g,'Head')
        strand('Noseband',[(side*.17,1.08,2.09),(side*.18,1.34,2.04),(side*.12,1.53,2.015)],.024,saddle,g,'Head')
        ball('Bridle brass rosette',(side*.235,1.02,2.32),(.025,.032,.032),brass,g,'Head',16,10)
        for j in range(3):ball('Saddle rivet',(side*.42,-.34+j*.19,1.54),(.014,.014,.014),brass,g,'Body',12,8)
    link('Mouth bit',(-.15,1.51,1.97),(.15,1.51,1.97),.018,brass,g,'Head',12)
    saddlecloth(silk_cfg,g,brass)

def make_rig():
    data=bpy.data.armatures.new('Thoroughbred performance armature');rig=bpy.data.objects.new('Muchi Racing Rig',data);bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
    def b(n,h,t,parent=None):
        z=data.edit_bones.new(n);z.head=h;z.tail=t
        if parent:z.parent=data.edit_bones[parent]
    b('Root',(0,0,0),(0,0,.2));b('Body',(0,-.03,1.35),(0,.18,1.58),'Root');b('Neck',(0,.42,1.72),(0,.78,2.15),'Body');b('Head',(0,.88,2.24),(0,1.3,2.1),'Neck');b('Tail',(0,-.94,1.62),(0,-1.35,1.22),'Body')
    for n,x,y,z,ky,kz in [('Front_L',-.29,.53,1.36,.63,.78),('Front_R',.29,.53,1.36,.48,.78),('Hind_L',-.31,-.77,1.42,-.98,.74),('Hind_R',.31,-.77,1.42,-.58,.74)]:
        b(n+'_Upper',(x,y,z),(x,ky,kz),'Body');b(n+'_Lower',(x,ky,kz),(x,ky*.82,.2),n+'_Upper')
    b('Jockey_Body',(0,-.08,1.88),(0,.22,2.28),'Body');b('Jockey_Head',(0,.43,2.45),(0,.56,2.70),'Jockey_Body')
    b('Jockey_Arm_L',(-.20,.40,2.42),(-.24,.88,2.12),'Jockey_Body');b('Jockey_Arm_R',(.20,.40,2.42),(.24,.88,2.12),'Jockey_Body')
    bpy.ops.object.mode_set(mode='OBJECT');rig.show_in_front=True;rig['asset_group']='Rig';rig['included_groups']='Horse,Rider';rig['rig_bone']='Root'
    bpy.context.view_layer.update()
    for o in list(bpy.context.scene.objects):
        if o.type!='ARMATURE' and o.get('rig_bone') and data.bones.get(o.get('rig_bone')):
            m=o.matrix_world.copy();o.parent=rig;o.parent_type='BONE';o.parent_bone=o.get('rig_bone');o.matrix_world=m
    bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='POSE')
    action=bpy.data.actions.new('Gallop_Loop');rig.animation_data_create();rig.animation_data.action=action
    for frame in (1,7,13,19,25):
        phase=(frame-1)/24*math.tau
        for side,offset in [('L',0),('R',math.pi)]:
            for pair,scale in [('Front',.55),('Hind',.65)]:
                for suffix,amount in [('Upper',scale),('Lower',-.4)]:
                    pb=rig.pose.bones.get(pair+'_'+side+'_'+suffix)
                    if pb:
                        pb.rotation_mode='XYZ';pb.rotation_euler[0]=amount*math.sin(phase+offset+(math.pi if pair=='Hind' else 0)+(.7 if suffix=='Lower' else 0));pb.keyframe_insert(data_path='rotation_euler',frame=frame,group=pair+' '+side)
        pb=rig.pose.bones.get('Jockey_Body')
        if pb:pb.rotation_mode='XYZ';pb.rotation_euler[0]=math.radians(2.5*math.sin(phase*2));pb.keyframe_insert(data_path='rotation_euler',frame=frame,group='Rider')
    bpy.ops.object.mode_set(mode='OBJECT')
    for fc in action.fcurves:
        fc.modifiers.new('CYCLES')
        for key in fc.keyframe_points:key.interpolation='BEZIER'
    return rig

def studio():
    floor=material('Studio floor',(.015,.028,.046,1),.1,.32)
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.02));o=bpy.context.object;o.name='Preview stage';o.data.materials.append(floor);o['non_export']=True
    world=bpy.data.worlds.new('Deep navy world') if not bpy.data.worlds else bpy.data.worlds[0];bpy.context.scene.world=world;world.use_nodes=True
    world.node_tree.nodes['Background'].inputs['Color'].default_value=(.008,.018,.035,1);world.node_tree.nodes['Background'].inputs['Strength'].default_value=.3
    def area(name,loc,power,color,size,target):
        bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;l.name=name;l.data.energy=power;l.data.shape='DISK';l.data.size=size;l.data.color=color;l.rotation_euler=(Vector(target)-l.location).to_track_quat('-Z','Y').to_euler();l['non_export']=True
    area('Warm key light',(4,2.8,5.4),980,(1,.82,.66),4,(0,0,1.3));area('Cool softbox',(-3,1.6,3.7),760,(.55,.72,1),3.8,(0,0,1.4));area('Stadium rim',(0,-3.8,4.7),1220,(.48,.76,1),3.2,(0,0,1.5))
    bpy.ops.object.camera_add(location=(4.8,3.0,3.1));cam=bpy.context.object;cam.name='Hero camera';cam.data.type='ORTHO';cam.data.ortho_scale=5.8;cam.rotation_euler=(Vector((0,0,1.45))-cam.location).to_track_quat('-Z','Y').to_euler();cam['non_export']=True
    scene=bpy.context.scene;scene.camera=cam;scene.render.engine='BLENDER_EEVEE_NEXT';scene.eevee.taa_render_samples=32
    scene.render.resolution_x=1500;scene.render.resolution_y=1180;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False;scene.view_settings.view_transform='AgX'
    return scene

def export_fbx(path,groups,decimate_ratio=0):
    # Merge static pieces by material and bone to reduce Unity draw calls while
    # preserving the rigid attachment groups used by the prototype gallop.
    curves=[o for o in bpy.context.scene.objects if o.type=='CURVE' and not o.get('non_export') and o.get('asset_group','') in groups]
    if curves:
        bpy.ops.object.select_all(action='DESELECT')
        for o in curves:o.select_set(True)
        bpy.context.view_layer.objects.active=curves[0]
        bpy.ops.object.convert(target='MESH')
    buckets={}
    for o in bpy.context.scene.objects:
        if o.type!='MESH' or o.get('non_export') or o.get('asset_group','') not in groups:continue
        material_name=o.data.materials[0].name if o.data.materials and o.data.materials[0] else ''
        key=(o.get('asset_group',''),o.parent.name if o.parent else '',o.parent_bone if o.parent_type=='BONE' else '',material_name)
        buckets.setdefault(key,[]).append(o)
    for objects in buckets.values():
        if len(objects)<2:continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join()
    bpy.ops.object.select_all(action='DESELECT');selected=[]
    for o in bpy.context.scene.objects:
        if o.type not in ('MESH','CURVE','ARMATURE') or o.get('non_export'):continue
        g=o.get('asset_group','')
        if g in groups or (o.type=='ARMATURE' and any(x in o.get('included_groups','').split(',') for x in groups)):selected.append(o)
    for o in selected:o.select_set(True)
    if selected:
        bpy.context.view_layer.objects.active=next((o for o in selected if o.type=='ARMATURE'),selected[0])
        lod_modifiers=[]
        if decimate_ratio>0:
            for o in selected:
                if o.type=='MESH':
                    modifier=o.modifiers.new('Mobile opponent LOD reduction','DECIMATE');modifier.ratio=decimate_ratio;lod_modifiers.append((o,modifier))
        bpy.ops.export_scene.fbx(filepath=str(path),use_selection=True,object_types={'MESH','ARMATURE'},apply_scale_options='FBX_SCALE_ALL',bake_anim=True,bake_anim_use_all_actions=False,bake_anim_use_nla_strips=False,add_leaf_bones=False,axis_forward='-Z',axis_up='Y',use_mesh_modifiers=True,mesh_smooth_type='FACE',path_mode='COPY',embed_textures=True)
        for obj,modifier in lod_modifiers:obj.modifiers.remove(modifier)
    bpy.ops.object.select_all(action='DESELECT')

silk_index={cfg[0]:cfg for cfg in SILKS}
horse_index={cfg[0]:cfg for cfg in HORSES}

def partner(hcfg,scfg,render=True,modular=False,save_source=False):
    clear();horse(hcfg,scfg);jockey(scfg);rig=make_rig();scene=studio();scene.frame_end=24;scene.frame_set(1)
    name='Partner_'+hcfg[0]+'_'+scfg[0]
    if render:
        action=rig.animation_data.action;rig.animation_data.action=None
        for pose_bone in rig.pose.bones:pose_bone.rotation_euler=(0,0,0)
        scene.eevee.taa_render_samples=32;scene.render.resolution_x=1200;scene.render.resolution_y=960
        scene.render.filepath=str(PREVIEWS/(name+'.png'));bpy.ops.render.render(write_still=True)
        rig.animation_data.action=action;scene.frame_set(1)
    export_fbx(PARTNERS/(name+'.fbx'),{'Horse','Rider','Rig'})
    export_fbx(PARTNER_LODS/(name+'_LOD1.fbx'),{'Horse','Rider','Rig'},.16)
    if modular:
        export_fbx(MODULAR/('Horse_'+hcfg[0]+'.fbx'),{'Horse','Rig'})
        export_fbx(MODULAR/('Jockey_'+scfg[0]+'.fbx'),{'Rider','Rig'})
    if save_source:bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/(name+'.blend')))
    print('BUILT',name)

def course_kit():
    clear();turf=material('Race turf / ryegrass',(.045,.22,.085,1),0,.72);apron=material('Track apron',(.30,.23,.15,1),0,.82)
    rail=material('White lacquer safety rail',(.88,.91,.88,1),.16,.26);steel=material('Stadium steel',(.10,.17,.23,1),.55,.3)
    concrete=material('Grandstand concrete',(.34,.41,.45,1),.16,.4);glass=material('Blue grandstand glazing',(.08,.27,.37,1),.22,.19,.2);banner=material('Turf series banner',(.02,.20,.29,1),.1,.32);gold=material('Gold course trim',(.72,.45,.12,1),.72,.25)
    def cube(name,loc,size,m,bevel=.02):
        bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(m);mark(o,'Course')
        if bevel:b=o.modifiers.new('Architectural edge bevel','BEVEL');b.width=bevel;b.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
        return o
    cube('Cut turf straight segment',(0,-.08,0),(28,.16,48),turf,0);cube('Tan course apron',(0,-.18,0),(36,.08,48),apron,0)
    for side in (-1,1):
        x=side*13.5
        for z in range(-23,25,4):cube('White rail post',(x,.65,z),(.15,1.3,.15),rail)
        cube('Upper race rail',(x,1.18,0),(.18,.18,48),rail,.04);cube('Lower race rail',(x,.56,0),(.12,.12,48),rail,.03)
    for tier in range(5):
        x=-18-tier*1.9;y=3+tier*2.1;cube('Grandstand terrace',(x,y,0),(3.8,1.25,38),concrete,.12);cube('Seat fascia',(x+.15,y+.72,0),(3.5,.12,36),banner if tier==0 else steel,.03)
    for i in range(9):cube('Canopy rib',(-19-i*.2,15,0),(.16,.35,40),steel,.05)
    cube('Covered grandstand roof',(-20,15.2,0),(5.4,.38,42),steel,.16);cube('Panoramic glass wall',(-16.7,8.6,0),(.16,6.2,37),glass,.05)
    cube('Turf series fascia',(-17.4,5.4,0),(.22,1.05,32),banner,.05)
    for z in (-16,16):cube('Gold sign upright',(-17.22,5.4,z),(.25,1.18,.12),gold)
    for z in (-18,18):
        cube('Stadium mast',(-23,8,z),(.22,16,.22),steel,.08);cube('Floodlight bar',(-23,16,z),(4,.22,.6),steel,.08)
        lamp=material('Warm LED lamp',(.95,.84,.62,1),.2,.2)
        for i in range(3):ball('Stadium floodlight',(-21.3+i*.75,15.85,z),(.22,.11,.14),lamp,'Course','Root',16,10)
    cube('Finish post left',(-10,5,21),(.35,10,.45),rail,.08);cube('Finish post right',(10,5,21),(.35,10,.45),rail,.08);cube('Finish gantry',(0,10,21),(21,.42,.55),steel,.1);cube('Finish sign',(0,10.7,21),(8,1.2,.28),banner,.08)
    cube('Finish line',(0,.012,18),(28,.035,.36),material('Finish chalk',(.97,.97,.87,1)),0)
    for i in range(7):
        x=-7+i*2;cube('Starting gate upright',(x,1.65,-20),(.12,3.3,.16),steel);cube('Starting gate header',(x,3.25,-20),(2,.18,.18),gold)
    cube('Starting gate fascia',(0,3.5,-20),(14,.72,.5),banner,.12)
    palette=[material('Spectator coral',(.58,.16,.13,1)),material('Spectator ivory',(.68,.63,.52,1)),material('Spectator blue',(.10,.25,.42,1)),material('Spectator green',(.11,.36,.27,1))]
    random.seed(7)
    for row in range(4):
        x=-17.2-row*1.9;y=3.8+row*2.05
        for i in range(36):ball('Spectator silhouette',(x,y,-16+i*.92),(.10,.12,.10),palette[(i+row)%4],'Course','Root',8,6)
    bpy.ops.object.camera_add(location=(44,31,39));cam=bpy.context.object;cam.rotation_euler=(Vector((0,4,0))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=50;cam['non_export']=True
    world=bpy.data.worlds.new('Racecourse preview sky') if not bpy.data.worlds else bpy.data.worlds[0];bpy.context.scene.world=world;world.use_nodes=True;world.node_tree.nodes['Background'].inputs['Color'].default_value=(.10,.20,.34,1);world.node_tree.nodes['Background'].inputs['Strength'].default_value=.45
    for name,loc,power,color,size in [('Course key',(-20,28,7),2200,(1,.78,.5),18),('Course fill',(18,22,-20),1600,(.38,.64,1),15)]:
        bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;l.name=name;l.data.energy=power;l.data.shape='DISK';l.data.size=size;l.data.color=color;l.rotation_euler=(Vector((0,3,0))-l.location).to_track_quat('-Z','Y').to_euler();l['non_export']=True
    scene=bpy.context.scene;scene.camera=cam;scene.render.engine='BLENDER_EEVEE_NEXT';scene.eevee.taa_render_samples=48;scene.render.resolution_x=1500;scene.render.resolution_y=1050;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.view_settings.view_transform='AgX'
    scene.eevee.taa_render_samples=24;scene.render.resolution_x=1100;scene.render.resolution_y=770
    scene.render.filepath=str(PREVIEWS/'Greenfield_Trackside_Kit.png');bpy.ops.render.render(write_still=True);export_fbx(MODULAR/'Greenfield_Trackside_Kit.fbx',{'Course'});bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'Greenfield_Trackside_Kit.blend'));print('BUILT Greenfield_Trackside_Kit')

if __name__=='__main__':
    bpy.context.preferences.filepaths.save_version=0
    catalog=[]
    for hi,hcfg in enumerate(HORSES):
        for si,scfg in enumerate(SILKS):
            featured=hi==si
            partner(hcfg,scfg,featured,featured,featured)
            catalog.append({'id':'Partner_'+hcfg[0]+'_'+scfg[0],'horse':hcfg[1],'coat':hcfg[0],'silk':scfg[0],'silkName':scfg[1],'preview':('Art/3DPreviews/Partner_'+hcfg[0]+'_'+scfg[0]+'.png') if featured else None,'model':'Models/Partners/Partner_'+hcfg[0]+'_'+scfg[0],'opponentLod':'Models/PartnerLODs/Partner_'+hcfg[0]+'_'+scfg[0]+'_LOD1'})
    with open(PARTNERS/'catalog.json','w',encoding='utf-8') as f:json.dump({'coordinateSystem':'Unity: +Y up, +Z forward','source':'Original Blender-authored procedural meshes','partnerVariants':catalog},f,ensure_ascii=False,indent=2)
    if not (MODULAR/'Greenfield_Trackside_Kit.fbx').exists():course_kit()
    print('ASSET LIBRARY COMPLETE')
