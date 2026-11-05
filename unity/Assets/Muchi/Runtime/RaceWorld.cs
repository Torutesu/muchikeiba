using System;
using System.Collections.Generic;
using Muchi.Client;
using Muchi.Engine;
using Muchi.Game;
using UnityEngine;

namespace Muchi.Client
{
    /// <summary>
    /// Race presentation. Positions come only from the authoritative engine (IRaceDriver → RaceSim states),
    /// mapped to the scene by CourseFrame (finish line at z=420 facing +Z, where the grandstand is).
    /// Straight-only courses (the first-ride tutorial) use the original Greenfield straight; courses with
    /// corners get rails and turf generated from the engine's track geometry.
    /// </summary>
    public sealed class RaceWorld : MonoBehaviour
    {
        public GameObject HorsePrefab;
        public int PlayerPartnerIndex;
        public readonly List<Transform> Horses = new List<Transform>();
        readonly List<Material> materials = new List<Material>();
        GameObject[] partnerPrefabs = Array.Empty<GameObject>();
        GameObject[] partnerLodPrefabs = Array.Empty<GameObject>();
        Transform course, staticCourse, generatedCourse, stands;
        Camera view;
        Light sun;
        bool racing;
        CourseFrame frame;
        double xShift;
        int runners;
        int playerSlot;
        public void Initialize()
        {
            partnerPrefabs = Resources.LoadAll<GameObject>("Models/Partners");
            partnerLodPrefabs = Resources.LoadAll<GameObject>("Models/PartnerLODs");
            Array.Sort(partnerPrefabs, (a,b) => string.CompareOrdinal(a.name,b.name));
            RenderSettings.ambientLight = new Color(.66f, .76f, .86f);
            RenderSettings.fog = true; RenderSettings.fogColor = new Color(.68f,.83f,.95f);
            RenderSettings.fogMode = FogMode.ExponentialSquared; RenderSettings.fogDensity = .0014f;
            sun = new GameObject("Afternoon sun").AddComponent<Light>();
            sun.transform.SetParent(transform); sun.type = LightType.Directional;
            sun.intensity = 1.25f; sun.shadows = LightShadows.Soft;
            sun.transform.rotation = Quaternion.Euler(38,-35,0);
            view = new GameObject("Chase camera").AddComponent<Camera>();
            view.transform.SetParent(transform); view.backgroundColor = new Color(.39f,.69f,.94f);
            view.clearFlags = CameraClearFlags.SolidColor; view.fieldOfView = 57; view.farClipPlane = 1200;
            view.gameObject.AddComponent<AudioListener>();
            course = new GameObject("Greenfield racecourse").transform; course.SetParent(transform);
            staticCourse = new GameObject("Greenfield straight").transform; staticCourse.SetParent(course);
            var turf = Mat(new Color(.23f,.48f,.12f)); var rail = Mat(new Color(.95f,.96f,.91f));
            Box("Turf",new Vector3(0,-.22f,220),new Vector3(250,.4f,650),turf,staticCourse);
            for (int z = -60; z < 500; z += 10)
            {
                if (z % 20 == 0) Box("Mown turf stripe",new Vector3(0,-.008f,z),new Vector3(28,.012f,10),Mat(new Color(.27f,.52f,.14f)),staticCourse);
                foreach (float x in new[]{-15f,15f})
                {
                    Box("Rail post",new Vector3(x,.65f,z),new Vector3(.15f,1.3f,.15f),rail,staticCourse);
                    Box("Running rail",new Vector3(x,1.25f,z+5),new Vector3(.15f,.15f,10),rail,staticCourse);
                }
            }
            BuildStands(-1);
            Box("Finish beam",new Vector3(0,7,420),new Vector3(32,.35f,.4f),rail,course);
            foreach(float x in new[]{-15f,15f}) Box("Finish post",new Vector3(x,3.5f,420),new Vector3(.4f,7,.4f),rail,course);
            for(int i=0;i<12;i++)
            {
                Transform h = CreatePartner(i);
                Horses.Add(h);
            }
            Lobby();
        }
        // Grandstand, canopy and crowd along the home straight, on the outside of the course (side = -1 left, +1 right).
        int standsSide;
        void BuildStands(int side)
        {
            if(stands!=null&&standsSide==side)return;
            standsSide=side;
            if(stands!=null)Destroy(stands.gameObject);
            stands=new GameObject("Grandstand").transform;stands.SetParent(course);
            var concrete = Mat(new Color(.58f,.65f,.70f)); var roof = Mat(new Color(.12f,.23f,.32f));
            for (int tier = 0; tier < 5; tier++)
                Box("Grandstand terrace",new Vector3(side*(35+tier*3),1+tier*2,160),new Vector3(8,2,230),concrete,stands);
            Box("Grandstand canopy",new Vector3(side*42,15,160),new Vector3(29,.5f,250),roof,stands);
            var crowdMats = new[]{Mat(new Color(.9f,.3f,.25f)),Mat(new Color(.9f,.85f,.7f)),Mat(new Color(.15f,.35f,.65f))};
            for(int i=0;i<300;i++) Box("Crowd block",new Vector3(side*(34+(i%5)*3),2+(i%5)*2,48+(i/5)*3.8f),new Vector3(.65f,.85f,.65f),crowdMats[i%3],stands);
        }
        // Lobby / wardrobe model (Codex's featured partners; slot 0).
        Transform CreatePartner(int slot)
        {
            if(HorsePrefab!=null)return Instantiate(HorsePrefab,transform).transform;
            if(partnerPrefabs.Length==0)return ProxyHorse(slot);
            int featuredIndex=Mathf.Clamp(PlayerPartnerIndex,0,PartnerCatalog.Featured.Length-1);
            int playerChoice=Array.FindIndex(partnerPrefabs,p=>p.name==PartnerCatalog.Featured[featuredIndex]);
            int choice=slot==0?(playerChoice>=0?playerChoice:0):(slot*7+3)%partnerPrefabs.Length;
            var modelSource=partnerPrefabs[choice];
            if(slot>0)
            {
                int lod=Array.FindIndex(partnerLodPrefabs,p=>p.name==modelSource.name+"_LOD1");
                if(lod>=0)modelSource=partnerLodPrefabs[lod];
            }
            return Anchor(slot,modelSource);
        }
        // A partner model from the catalog (resource path), falling back to the primitive proxy.
        Transform CreatePartner(int slot,string resourcePath)
        {
            if(HorsePrefab!=null)return Instantiate(HorsePrefab,transform).transform;
            var source=string.IsNullOrEmpty(resourcePath)?null:Resources.Load<GameObject>(resourcePath);
            return source==null?ProxyHorse(slot):Anchor(slot,source);
        }
        Transform Anchor(int slot,GameObject modelSource)
        {
            var anchor=new GameObject("Partner lane "+slot).transform;anchor.SetParent(transform,false);
            var model=Instantiate(modelSource,anchor,false);model.name=modelSource.name+" / model";
            model.transform.localPosition=Vector3.zero;
            // Blender source scenes use Z-up with the horse facing +Y. FBX export maps this to Unity -Z-forward.
            model.transform.localRotation=Quaternion.Euler(0,180f,0);
            model.transform.localScale=Vector3.one*.95f;
            var motion=anchor.gameObject.AddComponent<PartnerGallop>();motion.Bind(model.transform);
            return anchor;
        }
        public void SetPlayerPartner(int index)
        {
            PlayerPartnerIndex=Mathf.Clamp(index,0,4);
            if(Horses.Count==0)return;
            var previous=Horses[0];var position=previous.position;var rotation=previous.rotation;var active=previous.gameObject.activeSelf;
            Destroy(previous.gameObject);
            var replacement=CreatePartner(0);replacement.position=position;replacement.rotation=rotation;replacement.gameObject.SetActive(active);Horses[0]=replacement;
        }
        Material Mat(Color color)
        {
            var m = new Material(Shader.Find("Standard")); m.color = color;
            m.SetFloat("_Glossiness",.24f); materials.Add(m); return m;
        }
        Transform ProxyHorse(int slot)
        {
            var root = new GameObject("Horse proxy " + slot).transform; root.SetParent(transform);
            var coat = Mat(slot%3==0 ? new Color(.42f,.19f,.09f) : slot%3==1 ? new Color(.16f,.11f,.08f) : new Color(.55f,.51f,.45f));
            var dark = Mat(new Color(.08f,.065f,.055f)); var white = Mat(new Color(.95f,.95f,.9f));
            var silk = Mat(slot==0?new Color(.85f,.08f,.1f):Color.HSVToRGB(slot/12f,.75f,.8f));
            Ellipsoid("Body",new Vector3(0,1.55f,0),new Vector3(.7f,1,1.8f),coat,root);
            var neck = Ellipsoid("Neck",new Vector3(0,2, .7f),new Vector3(.46f,1.25f,.55f),coat,root); neck.localRotation=Quaternion.Euler(30,0,0);
            Ellipsoid("Head",new Vector3(0,2.6f,1.15f),new Vector3(.38f,.42f,.8f),coat,root);
            for(int side=-1;side<=1;side+=2)
            {
                Ellipsoid("Ear",new Vector3(side*.14f,2.95f,.95f),new Vector3(.1f,.38f,.13f),coat,root);
                Ellipsoid("Eye",new Vector3(side*.19f,2.67f,1.3f),Vector3.one*.07f,dark,root);
                for(int end=-1;end<=1;end+=2) Box("Leg",new Vector3(side*.25f,.65f,end*.6f),new Vector3(.15f,1.3f,.17f),coat,root);
            }
            Ellipsoid("Tail",new Vector3(0,1.4f,-1.05f),new Vector3(.2f,.9f,.25f),dark,root);
            Box("Saddle cloth",new Vector3(0,2.05f,0),new Vector3(.76f,.12f,.8f),silk,root);
            var torso = Ellipsoid("Jockey silks",new Vector3(0,2.45f,.12f),new Vector3(.5f,.65f,.35f),silk,root);torso.localRotation=Quaternion.Euler(45,0,0);
            Ellipsoid("Helmet",new Vector3(0,2.83f,.48f),new Vector3(.36f,.35f,.36f),silk,root);
            foreach(float x in new[]{-.37f,.37f}) Box("Breeches",new Vector3(x,2,.05f),new Vector3(.16f,.5f,.3f),white,root);
            return root;
        }
        Transform Ellipsoid(string name, Vector3 p, Vector3 s, Material m, Transform parent)
        { return Shape(PrimitiveType.Sphere,name,p,s,m,parent); }
        Transform Box(string name,Vector3 p,Vector3 s,Material m,Transform parent)
        { return Shape(PrimitiveType.Cube,name,p,s,m,parent); }
        Transform Shape(PrimitiveType type,string name,Vector3 p,Vector3 s,Material m,Transform parent)
        {
            var g=GameObject.CreatePrimitive(type);g.name=name;g.transform.SetParent(parent,false);
            g.transform.localPosition=p;g.transform.localScale=s;g.GetComponent<Renderer>().sharedMaterial=m;
            Destroy(g.GetComponent<Collider>());return g.transform;
        }
        public void Lobby()
        {
            racing=false;
            if(generatedCourse!=null){Destroy(generatedCourse.gameObject);generatedCourse=null;}
            staticCourse.gameObject.SetActive(true);BuildStands(-1);SetNight(false);
            foreach(var h in Horses){var motion=h.GetComponent<PartnerGallop>();if(motion!=null)motion.SetRacing(false);}
            for(int i=0;i<Horses.Count;i++) { Horses[i].gameObject.SetActive(i==0);Horses[i].position=new Vector3(0,0,25);Horses[i].rotation=Quaternion.Euler(0,-25,0); }
            view.transform.position=new Vector3(4,2.8f,31); view.transform.LookAt(new Vector3(0,1.65f,25));
        }
        /// <summary>
        /// Prepare a race from the engine config: course from the track geometry, one partner model per entrant
        /// (player = equipped wardrobe partner; others from start.visuals through the partner catalog).
        /// </summary>
        public void StartRace(RaceConfig config,RaceVisuals visuals,int player,PartnerCatalog catalog)
        {
            racing=true;playerSlot=player;runners=config.Entrants.Count;
            frame=CourseFrame.For(config,visuals);
            bool straight=config.Track.Segments.TrueForAll(s=>s.Kind==SegmentKind.Straight);
            // Straight courses reuse the Greenfield straight (rails at x=±15): centre the field between its rails.
            xShift=straight?-(frame.LaneCount*frame.LaneWidthMm/1000.0)/2:0;
            staticCourse.gameObject.SetActive(straight);
            BuildStands(straight?-1:(int)frame.OutsideSign);
            if(generatedCourse!=null){Destroy(generatedCourse.gameObject);generatedCourse=null;}
            if(!straight)BuildCourse(config.Track.Surface==Surface.Dirt);
            SetNight(visuals?.Track!=null&&visuals.Track.Night);
            foreach(var h in Horses)if(h!=null)Destroy(h.gameObject);
            Horses.Clear();
            for(int i=0;i<runners;i++)
            {
                string path=null;
                if(catalog!=null)
                {
                    PartnerVariant v;
                    if(i==playerSlot)v=catalog.Get(PartnerCatalog.Featured[Mathf.Clamp(PlayerPartnerIndex,0,4)]);
                    else{var e=visuals?.ForSlot(i);v=catalog.Resolve(e?.Appearance,e?.Silks);}
                    if(v!=null)path=i==playerSlot?v.Model:(v.OpponentLod??v.Model);
                }
                var h=path!=null?CreatePartner(i,path):CreatePartner(i==playerSlot?0:i);
                h.gameObject.SetActive(true);
                var motion=h.GetComponent<PartnerGallop>();if(motion!=null)motion.SetRacing(true);
                Horses.Add(h);
            }
        }
        void SetNight(bool night)
        {
            sun.intensity=night?.35f:1.25f;
            RenderSettings.ambientLight=night?new Color(.22f,.26f,.36f):new Color(.66f,.76f,.86f);
            view.backgroundColor=night?new Color(.04f,.06f,.12f):new Color(.39f,.69f,.94f);
            RenderSettings.fogColor=night?new Color(.05f,.07f,.12f):new Color(.68f,.83f,.95f);
        }
        // Rails and running surface generated from the engine's track geometry (render-only).
        void BuildCourse(bool dirt)
        {
            generatedCourse=new GameObject("Generated course").transform;generatedCourse.SetParent(course);
            var b=frame.Bounds();
            var ground=Mat(new Color(.20f,.42f,.11f));
            Box("Infield and surrounds",new Vector3((float)((b.minX+b.maxX)/2),-.25f,(float)((b.minZ+b.maxZ)/2)),new Vector3((float)(b.maxX-b.minX)+160,.4f,(float)(b.maxZ-b.minZ)+160),ground,generatedCourse);
            var surface=Mat(dirt?new Color(.55f,.40f,.26f):new Color(.27f,.53f,.15f));
            var rail=Mat(new Color(.95f,.96f,.91f));
            double mid=(CourseFrame.InnerRailM+frame.OuterRailM)/2, width=frame.OuterRailM-CourseFrame.InnerRailM+1;
            Ribbon("Running surface",frame.Line(mid,8),(float)width,.02f,-.03f,surface);
            foreach(var lat in new[]{CourseFrame.InnerRailM,frame.OuterRailM})
            {
                var line=frame.Line(lat,10);
                Ribbon("Running rail",line,.15f,.15f,1.25f,rail);
                foreach(var p in line)Box("Rail post",new Vector3((float)p.X,.65f,(float)p.Z),new Vector3(.15f,1.3f,.15f),rail,generatedCourse);
            }
        }
        // Boxes between consecutive points (a thin strip or bar following the course).
        void Ribbon(string name,List<WorldPose> line,float width,float height,float y,Material m)
        {
            for(int i=1;i<line.Count;i++)
            {
                var a=line[i-1];var c=line[i];
                var d=new Vector3((float)(c.X-a.X),0,(float)(c.Z-a.Z));
                if(d.sqrMagnitude<1e-4f)continue;
                var t=Box(name,new Vector3((float)(a.X+c.X)/2,y,(float)(a.Z+c.Z)/2),new Vector3(width,height,d.magnitude+.05f),m,generatedCourse);
                t.localRotation=Quaternion.LookRotation(d.normalized,Vector3.up);
            }
        }
        /// <summary>Draw every runner from the engine's interpolated state; chase camera behind the player.</summary>
        public void Present(IRaceDriver race,long nowMs)
        {
            if(!racing||frame==null)return;
            for(int i=0;i<Horses.Count;i++)
            {
                if(!race.TryGetRender(i,nowMs,out var from,out var to,out var alpha)){continue;}
                var p=frame.Horse(from,to,alpha);
                Horses[i].position=new Vector3((float)(p.X+xShift),.06f*Mathf.Sin(Time.time*13+i),(float)p.Z);
                Horses[i].rotation=Quaternion.Euler(0,(float)p.YawDegrees,0);
                var animator=Horses[i].GetComponentInChildren<Animator>();if(animator!=null)animator.SetFloat("Speed",to.Departed&&!to.Finished?1:0);
            }
            if(playerSlot<0||playerSlot>=Horses.Count)return;
            var me=Horses[playerSlot];
            var target=me.position-me.forward*6.5f+Vector3.up*3;
            view.transform.position=Vector3.Lerp(view.transform.position,target,1-Mathf.Exp(-Time.deltaTime*6));
            view.transform.LookAt(me.position+me.forward*9+Vector3.up*1.8f);
        }
        void OnDestroy(){foreach(var m in materials)if(m!=null)Destroy(m);}
    }
}
