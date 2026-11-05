using System;
using System.Collections.Generic;
using UnityEngine;

namespace Muchi.Client
{
    public sealed class RaceWorld : MonoBehaviour
    {
        public GameObject HorsePrefab;
        public int PlayerPartnerIndex;
        public readonly List<Transform> Horses = new List<Transform>();
        readonly List<Material> materials = new List<Material>();
        GameObject[] partnerPrefabs = Array.Empty<GameObject>();
        GameObject[] partnerLodPrefabs = Array.Empty<GameObject>();
        Transform course;
        Camera view;
        bool racing;
        float lane;
        public void Initialize()
        {
            partnerPrefabs = Resources.LoadAll<GameObject>("Models/Partners");
            partnerLodPrefabs = Resources.LoadAll<GameObject>("Models/PartnerLODs");
            Array.Sort(partnerPrefabs, (a,b) => string.CompareOrdinal(a.name,b.name));
            RenderSettings.ambientLight = new Color(.66f, .76f, .86f);
            RenderSettings.fog = true; RenderSettings.fogColor = new Color(.68f,.83f,.95f);
            RenderSettings.fogMode = FogMode.ExponentialSquared; RenderSettings.fogDensity = .0014f;
            var light = new GameObject("Afternoon sun").AddComponent<Light>();
            light.transform.SetParent(transform); light.type = LightType.Directional;
            light.intensity = 1.25f; light.shadows = LightShadows.Soft;
            light.transform.rotation = Quaternion.Euler(38,-35,0);
            view = new GameObject("Chase camera").AddComponent<Camera>();
            view.transform.SetParent(transform); view.backgroundColor = new Color(.39f,.69f,.94f);
            view.clearFlags = CameraClearFlags.SolidColor; view.fieldOfView = 57; view.farClipPlane = 1200;
            view.gameObject.AddComponent<AudioListener>();
            course = new GameObject("Greenfield racecourse").transform; course.SetParent(transform);
            var turf = Mat(new Color(.23f,.48f,.12f)); var rail = Mat(new Color(.95f,.96f,.91f));
            Box("Turf",new Vector3(0,-.22f,220),new Vector3(250,.4f,650),turf,course);
            for (int z = -60; z < 500; z += 10)
            {
                if (z % 20 == 0) Box("Mown turf stripe",new Vector3(0,-.008f,z),new Vector3(28,.012f,10),Mat(new Color(.27f,.52f,.14f)),course);
                foreach (float x in new[]{-15f,15f})
                {
                    Box("Rail post",new Vector3(x,.65f,z),new Vector3(.15f,1.3f,.15f),rail,course);
                    Box("Running rail",new Vector3(x,1.25f,z+5),new Vector3(.15f,.15f,10),rail,course);
                }
            }
            var concrete = Mat(new Color(.58f,.65f,.70f)); var roof = Mat(new Color(.12f,.23f,.32f));
            for (int tier = 0; tier < 5; tier++)
                Box("Grandstand terrace",new Vector3(-35-tier*3,1+tier*2,160),new Vector3(8,2,230),concrete,course);
            Box("Grandstand canopy",new Vector3(-42,15,160),new Vector3(29,.5f,250),roof,course);
            var crowdMats = new[]{Mat(new Color(.9f,.3f,.25f)),Mat(new Color(.9f,.85f,.7f)),Mat(new Color(.15f,.35f,.65f))};
            for(int i=0;i<300;i++) Box("Crowd block",new Vector3(-34-(i%5)*3,2+(i%5)*2,48+(i/5)*3.8f),new Vector3(.65f,.85f,.65f),crowdMats[i%3],course);
            Box("Finish beam",new Vector3(0,7,420),new Vector3(32,.35f,.4f),rail,course);
            foreach(float x in new[]{-15f,15f}) Box("Finish post",new Vector3(x,3.5f,420),new Vector3(.4f,7,.4f),rail,course);
            for(int i=0;i<12;i++)
            {
                Transform h = CreatePartner(i);
                Horses.Add(h);
            }
            Lobby();
        }
        Transform CreatePartner(int slot)
        {
            if(HorsePrefab!=null)return Instantiate(HorsePrefab,transform).transform;
            if(partnerPrefabs.Length==0)return ProxyHorse(slot);
            string[] featured={"Partner_Bay_Crimson","Partner_Chestnut_Azure","Partner_DappleGrey_Violet","Partner_Black_Emerald","Partner_Palomino_Gold"};
            int featuredIndex=Mathf.Clamp(PlayerPartnerIndex,0,featured.Length-1);
            int playerChoice=Array.FindIndex(partnerPrefabs,p=>p.name==featured[featuredIndex]);
            int choice=slot==0?(playerChoice>=0?playerChoice:0):(slot*7+3)%partnerPrefabs.Length;
            var anchor=new GameObject("Partner lane "+slot).transform;anchor.SetParent(transform,false);
            var modelSource=partnerPrefabs[choice];
            if(slot>0)
            {
                int lod=Array.FindIndex(partnerLodPrefabs,p=>p.name==modelSource.name+"_LOD1");
                if(lod>=0)modelSource=partnerLodPrefabs[lod];
            }
            var model=Instantiate(modelSource,anchor,false);model.name=modelSource.name+" / model";
            model.localPosition=Vector3.zero;
            // Blender source scenes use Z-up with the horse facing +Y. FBX export maps this to Unity -Z-forward.
            model.localRotation=Quaternion.Euler(0,180f,0);
            model.localScale=Vector3.one*.95f;
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
            foreach(var h in Horses){var motion=h.GetComponent<PartnerGallop>();if(motion!=null)motion.SetRacing(false);}
            for(int i=0;i<Horses.Count;i++) { Horses[i].gameObject.SetActive(i==0);Horses[i].position=new Vector3(0,0,25);Horses[i].rotation=Quaternion.Euler(0,-25,0); }
            view.transform.position=new Vector3(4,2.8f,31); view.transform.LookAt(new Vector3(0,1.65f,25));
        }
        public void StartRace(){racing=true;lane=0;foreach(var h in Horses){h.gameObject.SetActive(true);h.rotation=Quaternion.identity;var motion=h.GetComponent<PartnerGallop>();if(motion!=null)motion.SetRacing(true);}}
        public void MoveLane(float direction){lane=Mathf.Clamp(lane+direction*2,-11,11);}
        public void Present(RacePresentation state)
        {
            if(!racing)return;
            for(int i=0;i<12;i++)
            {
                var p=new Vector3(i==0?Mathf.Lerp(Horses[0].position.x,lane,Time.deltaTime*6):(i%6-2.5f)*3, .06f*Mathf.Sin(state.Time*13+i), state.Distance[i]-(i==0?0:(i/6)*4));
                Horses[i].position=p;
                var animator=Horses[i].GetComponentInChildren<Animator>();if(animator!=null)animator.SetFloat("Speed",1);
            }
            var target=Horses[0].position+new Vector3(0,3,-6.5f);
            view.transform.position=Vector3.Lerp(view.transform.position,target,1-Mathf.Exp(-Time.deltaTime*6));
            view.transform.LookAt(Horses[0].position+new Vector3(0,1.8f,9));
        }
        void OnDestroy(){foreach(var m in materials)if(m!=null)Destroy(m);}
    }
}
