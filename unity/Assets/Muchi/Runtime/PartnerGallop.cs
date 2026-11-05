using UnityEngine;

namespace Muchi.Client
{
    /// <summary>Lightweight runtime gallop for the rigidly-parented prototype partner models.</summary>
    public sealed class PartnerGallop : MonoBehaviour
    {
        static readonly string[] BoneNames =
        {
            "Front_L_Upper", "Front_L_Lower", "Front_R_Upper", "Front_R_Lower",
            "Hind_L_Upper", "Hind_L_Lower", "Hind_R_Upper", "Hind_R_Lower",
            "Jockey_Body", "Head"
        };
        readonly Transform[] bones = new Transform[BoneNames.Length];
        readonly Quaternion[] rest = new Quaternion[BoneNames.Length];
        Transform model;
        Vector3 modelPosition;
        bool racing;

        public void Bind(Transform partnerModel)
        {
            model=partnerModel;
            modelPosition=model.localPosition;
            var all=model.GetComponentsInChildren<Transform>(true);
            for(int i=0;i<all.Length;i++)
            {
                string name=all[i].name;
                int separator=name.LastIndexOf('|');
                if(separator>=0)name=name.Substring(separator+1);
                for(int b=0;b<BoneNames.Length;b++)
                    if(bones[b]==null && name==BoneNames[b])
                    {
                        bones[b]=all[i];rest[b]=all[i].localRotation;
                    }
            }
        }

        public void SetRacing(bool value)
        {
            racing=value;
            if(!racing)RestorePose();
        }

        void LateUpdate()
        {
            if(model==null)return;
            if(!racing){model.localPosition=modelPosition;return;}
            float cycle=Time.time*12.5f;
            model.localPosition=modelPosition+Vector3.up*(.018f+.028f*Mathf.Abs(Mathf.Sin(cycle*2f)));
            for(int i=0;i<8;i++)
            {
                if(bones[i]==null)continue;
                int leg=i/2;bool lower=(i%2)==1;bool left=(leg%2)==0;bool hind=leg>=2;
                float phase=cycle+(left?0f:Mathf.PI)+(hind?Mathf.PI:0f);
                float angle=lower?(-8f-17f*Mathf.Max(0f,Mathf.Sin(phase+1.0f))):(hind?27f:22f)*Mathf.Sin(phase);
                bones[i].localRotation=rest[i]*Quaternion.AngleAxis(angle,Vector3.right);
            }
            int rider=8;
            if(bones[rider]!=null)bones[rider].localRotation=rest[rider]*Quaternion.AngleAxis(2.2f*Mathf.Sin(cycle*2f),Vector3.right);
            int head=9;
            if(bones[head]!=null)bones[head].localRotation=rest[head]*Quaternion.AngleAxis(1.4f*Mathf.Sin(cycle),Vector3.right);
        }

        void RestorePose()
        {
            if(model!=null)model.localPosition=modelPosition;
            for(int i=0;i<bones.Length;i++)if(bones[i]!=null)bones[i].localRotation=rest[i];
        }
    }
}
