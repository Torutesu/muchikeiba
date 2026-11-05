using System;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;

namespace Muchi.Client
{
    public sealed class MuchiApp : MonoBehaviour
    {
        public GameObject HorsePrefab;
        RaceWorld world;
        readonly RacePresentation race = new RacePresentation();
        Canvas canvas;
        RectTransform safe;
        Font font;
        Text position, distance, stamina, feedback, spurs, clock;
        Image staminaFill;
        RectTransform[] dots;
        bool inRace, tutorial;
        Action currentScreen;
        string horseName, pendingName;
        string pendingPurchaseTitle, pendingPurchasePrice, pendingPurchaseKind;
        float messageUntil;
        int storeTab, previewCourse=-1, selectedAgeGroup=-1;
        bool purchaseReviewOpen;
        Action purchaseReturnScreen;
        readonly Color navy = new Color(.025f,.075f,.14f,.9f);
        readonly Color cyan = new Color(0,.8f,.95f);
        readonly Color gold = new Color(1,.83f,.08f);
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if(FindObjectOfType<MuchiApp>()==null)new GameObject("Muchi Frontend").AddComponent<MuchiApp>();
        }
        void Start()
        {
            Screen.orientation=ScreenOrientation.LandscapeLeft; Application.targetFrameRate=60;
            horseName=PlayerPrefs.GetString("muchi.partner","アカツキ");
            font=Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            world=new GameObject("Race world").AddComponent<RaceWorld>();world.HorsePrefab=HorsePrefab;world.PlayerPartnerIndex=EquippedPartner;world.Initialize();
            canvas=new GameObject("Sports HUD",typeof(Canvas),typeof(CanvasScaler),typeof(GraphicRaycaster)).GetComponent<Canvas>();
            canvas.renderMode=RenderMode.ScreenSpaceOverlay;
            var scaler=canvas.GetComponent<CanvasScaler>();scaler.uiScaleMode=CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution=new Vector2(1600,900);scaler.matchWidthOrHeight=(float)Screen.width/Screen.height >= 16f/9f ? 1f : 0f;
            if(FindObjectOfType<EventSystem>()==null)new GameObject("EventSystem",typeof(EventSystem),typeof(StandaloneInputModule));
            safe=new GameObject("Safe area",typeof(RectTransform)).GetComponent<RectTransform>();safe.SetParent(canvas.transform,false);
            ApplySafeArea();Title();
        }
        void ApplySafeArea()
        {
            var a=Screen.safeArea;safe.anchorMin=new Vector2(a.x/Screen.width,a.y/Screen.height);
            safe.anchorMax=new Vector2(a.xMax/Screen.width,a.yMax/Screen.height);safe.offsetMin=safe.offsetMax=Vector2.zero;
        }
        RectTransform Rect(string name,Transform parent,float x,float y,float w,float h)
        {
            var r=new GameObject(name,typeof(RectTransform)).GetComponent<RectTransform>();r.SetParent(parent,false);
            r.anchorMin=r.anchorMax=new Vector2(0,1);r.pivot=new Vector2(0,1);r.anchoredPosition=new Vector2(x,-y);r.sizeDelta=new Vector2(w,h);return r;
        }
        Image Panel(string name,float x,float y,float w,float h,Color color,Transform parent=null)
        {
            var r=Rect(name,parent??safe,x,y,w,h);var image=r.gameObject.AddComponent<Image>();image.color=color;return image;
        }
        Text Label(string value,float x,float y,float w,float h,int size=26,Color? color=null,Transform parent=null)
        {
            var r=Rect(value,parent??safe,x,y,w,h);var t=r.gameObject.AddComponent<Text>();t.font=LocaleService.UiFont!=null?LocaleService.UiFont:font;t.text=LocaleService.Text(value);
            t.fontSize=size;t.color=color??Color.white;t.fontStyle=FontStyle.Bold;t.raycastTarget=false;
            t.verticalOverflow=VerticalWrapMode.Overflow;return t;
        }
        RawImage ArtImage(string resource,float x,float y,float w,float h,Transform parent=null)
        {
            var texture=Resources.Load<Texture2D>(resource);
            var raw=new GameObject("Art / "+resource,typeof(RectTransform),typeof(RawImage)).GetComponent<RawImage>();
            raw.transform.SetParent(parent??safe,false);raw.texture=texture;raw.raycastTarget=false;
            var rect=raw.rectTransform;rect.anchorMin=rect.anchorMax=new Vector2(0,1);rect.pivot=new Vector2(0,1);
            rect.anchoredPosition=new Vector2(x,-y);rect.sizeDelta=new Vector2(w,h);return raw;
        }
        string SilkArt(int index)=>index==1?"Art/Cosmetics/jockey-cyan":index==2?"Art/Cosmetics/jockey-violet":"Art/Cosmetics/jockey-crimson";
        string CourseArt(int index)=>index==1?"Art/Courses/spring-course":index==2?"Art/Courses/autumn-course":"Art/home-paddock";
        string WeatherArt(int index)=>"Art/Weather/"+(index==1?"cloudy":index==2?"rain":index==3?"fog":"sunny");
        string FoodArt(int index)=>"Art/Food/"+(index==1?"hay-carrot":index==2?"water-bucket":"oats-apple");
        string PartnerPreview(int index)=>"Art/3DPreviews/Partner_"+new[]{"Bay_Crimson","Chestnut_Azure","DappleGrey_Violet","Black_Emerald","Palomino_Gold"}[Mathf.Clamp(index,0,4)];
        int EquippedPartner=>Mathf.Clamp(PlayerPrefs.GetInt("muchi.partner.model",0),0,4);
        int EquippedSilk=>Mathf.Clamp(PlayerPrefs.GetInt("muchi.cosmetic.silk",0),0,2);
        int EquippedCourse=>Mathf.Clamp(PlayerPrefs.GetInt("muchi.cosmetic.course",0),0,2);
        Button languageButton;
        Button Button(string value,float x,float y,float w,Action action,Color? color=null)
        {return Button(value,x,y,w,72,action,color);}
        Button Button(string value,float x,float y,float w,float h,Action action,Color? color=null)
        {
            var p=Panel(value,x,y,w,h,color??cyan);var b=p.gameObject.AddComponent<Button>();
            var colors=b.colors;colors.highlightedColor=new Color(.8f,.95f,1);colors.pressedColor=new Color(.5f,.7f,.8f);b.colors=colors;
            b.onClick.AddListener(()=>action());int fontSize=h<65?21:(w<220?20:27);
            var t=Label(value,12,Mathf.Max(2,(h-48)/2),w-24,48,fontSize,color.HasValue?Color.white:navy,p.transform);t.alignment=TextAnchor.MiddleCenter;return b;
        }
        void Clear()
        {
            inRace=false;languageButton=null;foreach(Transform child in safe)Destroy(child.gameObject);
            reinHeld=false;world.Lobby();ApplySafeArea();
            languageButton=Button(LocaleService.IsJapanese?"English":"日本語",1370,132,195,ToggleLanguage,navy);
            var languageText=languageButton.GetComponentInChildren<Text>();
            if(languageText!=null&&LocaleService.UiFont!=null)languageText.font=LocaleService.UiFont;
        }
        void ToggleLanguage(){LocaleService.Toggle();currentScreen?.Invoke();}
        void LateUpdate()
        {
            if(languageButton!=null)languageButton.transform.SetAsLastSibling();
        }
        void SetArt(string resource)
        {
            var texture=Resources.Load<Texture2D>(resource);
            if(texture==null)return;
            var raw=new GameObject("Screen key art",typeof(RectTransform),typeof(RawImage)).GetComponent<RawImage>();
            raw.transform.SetParent(safe,false);raw.texture=texture;raw.raycastTarget=false;
            var rect=raw.rectTransform;rect.anchorMin=Vector2.zero;rect.anchorMax=Vector2.one;
            rect.offsetMin=Vector2.zero;rect.offsetMax=Vector2.zero;
            if(languageButton!=null)languageButton.transform.SetAsLastSibling();
        }
        void Tag(string title)
        {Panel("Header",35,30,650,65,navy);Label("/  "+title,55,42,620,45,30);Label("LOCAL PRESENTATION DEMO",35,850,800,30,17,new Color(.8f,.9f,1));}
        void Title()
        {
            currentScreen=Title;Clear();SetArt("Art/title-screen");
            // A subtle edge veil protects text contrast while keeping the horse as the hero.
            Panel("Title legibility veil",0,0,720,900,new Color(.015f,.055f,.11f,.30f));
            Panel("Top wordmark rule",76,105,116,5,cyan);
            Label("ムチ一閃",74,135,700,130,92,Color.white);
            Label("MUCHI ISSEN  /  JOCKEY RACING",82,270,650,39,21,new Color(.82f,.92f,1f));
            Panel("Title accent rule",82,335,65,4,gold);
            Label(LocaleService.IsJapanese?"最後の直線を、\n相棒と。":"Win together on the final straight.",78,370,720,180,54,Color.white);
            Label("A RACE IS WON IN THE LAST STRAIGHT.",84,560,720,42,21,new Color(.88f,.93f,.96f));
            var start=Button("RACE  /  START",80,690,420,()=>BeginRace(true));
            start.GetComponent<Image>().color=cyan;
            Label("TAP TO RIDE",90,785,400,34,17,new Color(.89f,.96f,1f));
            Label("SEASON 01    •    TURF SERIES",1110,828,450,34,16,Color.white);
        }
        void Home()
        {
            currentScreen=Home;Clear();SetArt("Art/home-paddock");
            Panel("Player identity",38,34,440,104,navy);
            Label("ROOKIE II  /  SEASON 01",60,47,390,36,20,cyan);
            Label("JOCKEY  001  ·  TURF SERIES",60,90,390,30,17);
            Panel("Wallet",1210,35,350,86,navy);
            Label("FREE  ◎  1,200",1230,46,155,29,17,Color.white);
            Label("PAID  ◈  240",1390,46,155,29,17,gold);
            Label("Wallet balance",1230,79,300,25,14,new Color(.75f,.85f,.91f));
            Panel("Home greeting",38,244,480,230,navy);
            Label("YOUR PARTNER",66,275,420,36,20,cyan);
            Label(horseName,66,318,425,78,49);
            Label("CLOSER  /  TURF  /  2,000m",66,408,425,35,18);
            Button("STABLE",1180,248,176,Stable,navy);
            Button("SCOUT",1374,248,176,Scout,navy);
            Button("WARDROBE",1180,328,176,Wardrobe,navy);
            Button("COURSE",1374,328,176,CourseThemes,navy);
            Button("SEASON PASS",1180,408,176,SeasonPass,navy);
            Button("SHOP",1374,408,176,()=>{storeTab=0;Store();},navy);
            Button("CARE / FEED",1180,488,176,Care,navy);
            Button("CONDITIONS",1374,488,176,Conditions,navy);
            var raceButton=Button("RACE  >>",1160,668,392,()=>Entry());
            raceButton.GetComponent<Image>().color=cyan;
            Label("RANKED  /  GREENFIELD CUP",1180,754,380,35,17,Color.white);
            Label("HOME   ·   ABILITY-CAPPED RANKED RACE",48,836,700,32,16,Color.white);
        }
        void NamePartner()
        {
            currentScreen=NamePartner;Clear();SetArt("Art/partner-naming");
            Panel("Name panel",980,75,580,735,navy);
            Label("01  /  YOUR FIRST PARTNER",1020,110,500,35,17,cyan);
            Label("NAME YOUR PARTNER",1020,162,500,56,31);
            Label("A good name makes a great story.",1020,225,500,38,18,new Color(.82f,.9f,.96f));
            Label("PARTNER NAME",1020,310,500,32,17,cyan);
            var fieldPanel=Panel("Name field",1020,353,495,75,new Color(.13f,.2f,.27f));
            var field=fieldPanel.gameObject.AddComponent<InputField>();field.characterLimit=12;
            var text=Label(horseName,15,12,465,50,30,Color.white,fieldPanel.transform);
            field.textComponent=text;field.text=string.IsNullOrEmpty(pendingName)?horseName:pendingName;
            field.onValueChanged.AddListener(value=>pendingName=value);
            Label("SPEED   84        STAMINA   78\nPOWER   81        STYLE       CLOSER",1020,465,495,98,23);
            Label("You can change the name later.",1020,587,495,32,16,new Color(.82f,.9f,.96f));
            Button("CONFIRM  >>",1020,667,495,()=>{
                var value=field.text.Trim();if(value.Length<2){Info("NAME REQUIRED","Use 2 to 12 characters.",NamePartner);return;}
                horseName=value;pendingName=value;PlayerPrefs.SetString("muchi.partner",value);PlayerPrefs.Save();Scout();
            });
            Button("BACK",1020,758,150,()=>BeginRace(true),navy);
        }
        void Stable()
        {
            currentScreen=Stable;Clear();SetArt("Art/partner-naming");Panel("Stable detail",990,70,570,740,navy);
            Label("STABLE  /  01 OF 20",1030,108,480,34,17,cyan);
            Label(horseName,1030,161,480,72,44);
            Label("SSR   ·   CLOSER",1030,238,480,34,18,gold);
            Label("SPEED",1030,316,170,30,17);Label("84",1440,316,60,30,19,gold);Panel("Speed bar",1030,353,465,9,new Color(.08f,.8f,.95f));
            Label("STAMINA",1030,390,170,30,17);Label("78",1440,390,60,30,19,gold);Panel("Stamina bar",1030,427,435,9,new Color(.08f,.8f,.95f));
            Label("POWER",1030,465,170,30,17);Label("81",1440,465,60,30,19,gold);Panel("Power bar",1030,502,450,9,new Color(.08f,.8f,.95f));
            Label("APTITUDE",1030,545,200,30,17,cyan);
            Label("TURF  A       MIDDLE  A       GOOD  A",1030,585,480,58,18);
            var raceButton=Button("SELECT FOR RACE  >>",1030,680,470,()=>Entry());raceButton.GetComponent<Image>().color=cyan;
            Button("BACK",1030,760,170,Home,navy);
            Button("CARE / FEED",1215,760,285,Care,navy);
        }
        void Scout()
        {
            currentScreen=Scout;Clear();SetArt("Art/scout-reveal");Panel("Scout info",40,60,550,780,navy);
            bool freeAvailable=PlayerPrefs.GetInt("muchi.tutorial.scout.used",0)==0;
            Label(freeAvailable?"WELCOME SCOUT  /  FREE 10":"FEATURED SCOUT  /  PREVIEW",78,101,470,40,18,cyan);
            Label("MEET YOUR\nNEXT PARTNER",78,165,480,150,40);
            Panel("Rarity badge",78,355,128,49,gold);Label("SR+  GUARANTEED",87,366,112,28,16,navy);
            Label("Ten horses. One new story.",78,427,455,38,18);
            if(freeAvailable)
            {
                Label("Your first 10-pull is free.\nAt least one SR horse is included.",78,470,455,76,20);
                Label("FREE PREVIEW  /  NO CURRENCY USED",78,564,450,30,14,new Color(.72f,.83f,.91f));
                Button("FREE 10-HORSE SCOUT",78,625,470,RevealScout);
            }
            else
            {
                Label("Paid scout: 100 coins / 1 pull\n10-pull: 1 SR+ guaranteed\nExchange at 100 pulls.",78,470,455,105,19);
                Label("PAID SCOUT PAUSED  /  RATE TABLE NOT SET",78,586,450,45,14,gold);
                Label("We will enable draws after official rates are configured.",78,627,445,52,15,new Color(.82f,.9f,.96f));
                Button("VIEW COIN SHOP",78,690,280,()=>{storeTab=0;Store();},cyan);
            }
            Button("BACK TO HOME",78,774,200,Home,navy);
        }
        void RevealScout()
        {
            PlayerPrefs.SetInt("muchi.tutorial.scout.used",1);PlayerPrefs.Save();
            currentScreen=RevealScout;Clear();SetArt("Art/scout-reveal");Panel("Scout result",40,70,560,760,navy);
            Label("NEW PARTNERS  /  10",78,105,475,34,17,cyan);
            Label("KOHAKU",78,166,470,70,47);Label("SR  ·  FRONT RUNNER",78,237,470,36,20,gold);
            Label("A bold start and a steady stride.\nTURF  /  SHORT DISTANCE",78,297,470,78,19);
            Panel("Horse result divider",78,400,455,2,new Color(.35f,.55f,.66f));
            Label("SHIRANAMI",78,430,470,58,36);Label("SR  ·  CLOSER",78,488,470,34,18,gold);
            Label("Eight more partners joined your stable.",78,549,470,56,18);
            Label("Fixed art preview; no server draw or currency transaction.",78,624,455,55,14,new Color(.72f,.83f,.91f));
            Button("GO TO HOME  >>",78,710,470,Home);
        }
        void Wardrobe()
        {
            currentScreen=Wardrobe;Clear();SetArt("Art/home-paddock");
            Panel("Partner wardrobe frame",38,54,1524,770,navy);
            Label("PARTNER WARDROBE  /  3D RACE MODELS",76,78,980,42,24,cyan);
            Label("Five thoroughbred coats and five racing silk sets. Appearance only in ranked races.",76,120,960,34,18,new Color(.78f,.89f,.96f));
            Panel("Selected partner preview",72,174,448,352,new Color(.03f,.09f,.15f,.96f));
            ArtImage(PartnerPreview(EquippedPartner),76,176,440,352);
            Panel("Selected partner details",72,530,448,178,new Color(.04f,.11f,.18f,.96f));
            Label(new[]{"KOHAKU  /  BAY · CRIMSON","AKANE  /  CHESTNUT · AZURE","SHIRANAMI  /  DAPPLE · VIOLET","YORU  /  BLACK · EMERALD","KINAKO  /  PALOMINO · GOLD"}[EquippedPartner],94,548,410,34,18,gold);
            Label("FULL 3D HORSE + JOCKEY PAIR",94,588,400,30,16,cyan);
            Label("Original coat, tack, racing silks and rider details.",94,626,400,52,15,new Color(.80f,.88f,.95f));
            string[] names={"KOHAKU · CRIMSON LAUREL","AKANE · AZURE CHEVRON","SHIRANAMI · VIOLET STAR","YORU · EMERALD CHECK","KINAKO · MIDNIGHT GOLD"};
            Color[] accents={new Color(.74f,.12f,.2f),cyan,new Color(.56f,.35f,.88f),new Color(.12f,.65f,.38f),gold};
            for(int i=0;i<5;i++)
            {
                int look=i;float x=548+(i%3)*326;float y=174+(i/3)*276;
                Panel("Partner card "+i,x,y,306,260,new Color(.055f,.13f,.21f,.98f));
                Panel("Partner accent "+i,x,y,306,5,accents[i]);
                ArtImage(PartnerPreview(i),x+38,y+11,230,184);
                Label(names[i],x+12,y+193,282,28,15,i==EquippedPartner?gold:Color.white);
                var equip=Button(i==EquippedPartner?"EQUIPPED":"EQUIP PARTNER",x+13,y+222,280,32,()=>EquipPartner(look),navy);
                if(i==EquippedPartner)equip.interactable=false;
            }
            Panel("Partner vanity note",548,732,956,40,new Color(.04f,.11f,.18f,.94f));
            Label("HORSE COAT  /  RACING SILKS  /  SADDLE  /  BRIDLE  ·  COSMETIC ONLY",566,739,920,27,15);
            Button("BACK",76,785,180,Home,navy);
            Button("BROWSE COSMETICS",1115,785,380,()=>{storeTab=1;Store();},cyan);
        }
        void EquipPartner(int look)
        {
            PlayerPrefs.SetInt("muchi.partner.model",look);PlayerPrefs.Save();world.SetPlayerPartner(look);Wardrobe();
        }
        void CourseThemes()
        {
            currentScreen=CourseThemes;int activePreview=previewCourse>=0?previewCourse:EquippedCourse;
            Clear();SetArt(CourseArt(activePreview));
            Panel("Course screen veil",0,0,1600,900,new Color(.01f,.04f,.08f,.45f));
            Panel("Course selector frame",36,52,1528,770,navy);
            Label("RACECOURSE LOOKS  /  COSMETIC",70,72,860,42,24,cyan);
            Label("Course skins change the scene only. Ranked rules stay the same for everyone.",70,115,1050,34,18);
            string[] names={"GREENFIELD TURF","SPRING MEADOW","AUTUMN GOLD"};
            string[] rarities={"N  ·  OWNED","SR  ·  PREVIEW","SSR  ·  PREVIEW"};
            for(int i=0;i<3;i++)
            {
                int theme=i;float x=57+i*500;
                Panel("Course card "+i,x,212,475,510,new Color(.045f,.12f,.19f,.97f));
                ArtImage(CourseArt(i),x+12,224,451,245);
                Label(names[i],x+22,482,430,36,22);
                Label(rarities[i],x+22,521,430,28,15,i==0?cyan:gold);
                Label(i==0?"Standard course environment.":"Visual environment preview. No gameplay advantage.",x+22,553,430,50,15,new Color(.8f,.88f,.94f));
                Button(theme==0?"EQUIP STANDARD":"PREVIEW",x+18,620,210,()=>SelectCoursePreview(theme),navy);
                Button(i==0?(EquippedCourse==0?"EQUIPPED":"USE LOOK"):"VIEW IN SHOP",x+245,620,210,i==0?(Action)EquipStandardCourse:(Action)OpenCourseShop,i==0?cyan:gold);
            }
            Label("Preview changes are temporary until a theme is owned and equipped.",70,744,850,32,16,new Color(.8f,.9f,.95f));
            Button("BACK",70,785,180,Home,navy);
            Button("COURSE THEME SHOP",1150,785,360,()=>{storeTab=2;Store();},cyan);
        }
        void SelectCoursePreview(int index){previewCourse=index;CourseThemes();}
        void EquipStandardCourse(){PlayerPrefs.SetInt("muchi.cosmetic.course",0);PlayerPrefs.Save();previewCourse=-1;CourseThemes();}
        void OpenCourseShop(){storeTab=2;Store();}
        void Conditions()
        {
            currentScreen=Conditions;
            int weather=Mathf.Clamp(PlayerPrefs.GetInt("muchi.race.weather",0),0,3);
            int surface=Mathf.Clamp(PlayerPrefs.GetInt("muchi.race.surface",1),0,3);
            int temperature=Mathf.Clamp(PlayerPrefs.GetInt("muchi.race.temperature",1),0,3);
            int wind=Mathf.Clamp(PlayerPrefs.GetInt("muchi.race.wind",0),0,3);
            Clear();SetArt(WeatherArt(weather));
            Panel("Conditions veil",0,0,1600,900,new Color(.015f,.045f,.08f,.55f));
            Panel("Conditions frame",30,45,1540,785,navy);
            Label("RACE CONDITIONS  /  PRIVATE ROOM PRESET",60,64,850,40,24,cyan);
            Label("Ranked races use official shared conditions. These settings are for private-room design.",60,106,1150,30,17);
            string[] weatherNames={"SUNNY","CLOUDY","RAIN","MORNING FOG"};
            for(int i=0;i<4;i++)
            {
                int choice=i;float x=50+i*375;
                Panel("Weather card "+i,x,210,350,315,new Color(.045f,.12f,.19f,.96f));
                ArtImage(WeatherArt(i),x+8,218,334,190);
                Label(weatherNames[i],x+18,417,310,30,19);
                var choose=Button(i==weather?"SELECTED":"PREVIEW",x+12,453,326,58,()=>SetWeather(choice),i==weather?cyan:navy);
                if(i==weather)choose.interactable=false;
            }
            Panel("Detailed settings",50,535,1500,260,new Color(.035f,.095f,.16f,.97f));
            Label("GROUND",72,546,170,32,16,cyan);
            string[] ground={"FIRM","GOOD","SOFT","HEAVY"};
            for(int i=0;i<4;i++){int choice=i;var b=Button(ground[i],250+i*180,530,165,58,()=>SetCondition("muchi.race.surface",choice),i==surface?cyan:navy);if(i==surface)b.interactable=false;}
            Label("TEMPERATURE",72,613,170,32,16,cyan);
            int[] temps={14,18,22,26};
            for(int i=0;i<4;i++){int choice=i;var b=Button(temps[i]+" °C",250+i*180,600,165,58,()=>SetCondition("muchi.race.temperature",choice),i==temperature?cyan:navy);if(i==temperature)b.interactable=false;}
            Label("WIND",72,680,170,32,16,cyan);
            int[] winds={0,5,10,15};
            for(int i=0;i<4;i++){int choice=i;var b=Button(winds[i]+" km/h",250+i*180,667,165,58,()=>SetCondition("muchi.race.wind",choice),i==wind?cyan:navy);if(i==wind)b.interactable=false;}
            Label("Weather, ground, temperature and wind are saved as a room preset. They grant no paid advantage.",72,742,1360,27,15,new Color(.8f,.89f,.95f));
            Button("BACK",60,785,180,Home,navy);
            Button("WEATHER EFFECTS",1160,785,350,()=>PurchaseReview("Course atmosphere effects","¥240 (proposed)","COSMETIC"),gold);
        }
        void SetWeather(int choice){PlayerPrefs.SetInt("muchi.race.weather",choice);PlayerPrefs.Save();Conditions();}
        void SetCondition(string key,int value){PlayerPrefs.SetInt(key,value);PlayerPrefs.Save();Conditions();}
        void Care()
        {
            currentScreen=Care;int feed=Mathf.Clamp(PlayerPrefs.GetInt("muchi.care.feed",0),0,2);
            Clear();SetArt("Art/home-paddock");
            Panel("Care frame",38,55,1524,770,navy);
            Label("STABLE CARE  /  DAILY ROUTINE",76,76,760,42,24,cyan);
            Label("Choose a care focus freely. Ranked stats are normalized for fair competition.",76,118,1000,32,17);
            string[] feedNames={"GRAIN & APPLE","HAY & CARROT","FRESH WATER"};
            string[] rarity={"N  ·  COMMON","R  ·  SELECT","SR  ·  REFINED"};
            string[] focus={"Balanced condition","Endurance routine","Calm handling"};
            for(int i=0;i<3;i++)
            {
                int choice=i;float x=72+i*500;
                Panel("Care card "+i,x,210,465,485,new Color(.045f,.12f,.19f,.97f));
                ArtImage(FoodArt(i),x+25,225,415,255);
                Label(feedNames[i],x+26,490,410,35,20);
                Label(rarity[i],x+26,532,410,28,16,i==feed?gold:cyan);
                Label(focus[i],x+26,565,410,32,17);
                var b=Button(i==feed?"TODAY'S CARE SET":"CHOOSE CARE",x+22,610,420,()=>SelectFeed(choice),i==feed?cyan:navy);
                if(i==feed)b.interactable=false;
            }
            Panel("Premium decor",72,710,950,72,new Color(.035f,.095f,.16f,.97f));
            ArtImage("Art/Food/premium-bowl",80,702,80,80);
            Label("SSR STABLE BOWL  /  DECOR ONLY  /  NO FEED BONUS",170,731,760,34,17,gold);
            Button("VIEW DECOR",1170,710,300,()=>{storeTab=1;Store();},gold);
            Button("BACK",72,785,180,Home,navy);
        }
        void SelectFeed(int choice){PlayerPrefs.SetInt("muchi.care.feed",choice);PlayerPrefs.Save();Care();}
        void Store()
        {
            currentScreen=Store;Clear();SetArt("Art/home-paddock");
            Panel("Store frame",32,42,1536,790,navy);
            Label("MUCHI STORE  /  DIRECT, CLEAR PRICES",64,59,750,42,24,cyan);
            Label("FREE  ◎  1,200     PAID  ◈  240",930,64,390,34,19,gold);
            Button("COINS",55,132,250,()=>{storeTab=0;Store();},storeTab==0?cyan:navy);
            Button("COSMETICS",325,132,250,()=>{storeTab=1;Store();},storeTab==1?cyan:navy);
            Button("COURSE THEMES",595,132,250,()=>{storeTab=2;Store();},storeTab==2?cyan:navy);
            Button("SEASON PASS",865,132,250,()=>SeasonPass(),storeTab==3?cyan:navy);
            if(storeTab==0)DrawCoinPackages();
            else if(storeTab==1)DrawCosmetics();
            else if(storeTab==2)DrawCourseProducts();
            Label("Store checkout is not connected in this build. No purchase can be completed here.",62,777,1100,28,15,new Color(.8f,.89f,.95f));
            Button("BACK",1340,775,170,Home,navy);
        }
        void DrawCoinPackages()
        {
            int[] amounts={100,310,530,1020,1660,2680,3600,7400};
            string[] prices={"¥160","¥480","¥800","¥1,500","¥2,400","¥3,800","¥5,000","¥10,000"};
            for(int i=0;i<amounts.Length;i++)
            {
                int package=i;int col=i%2,row=i/2;float x=62+col*755,y=225+row*132;
                Panel("Coin pack "+i,x,y,705,116,new Color(.045f,.12f,.19f,.97f));
                Label(prices[i],x+22,y+13,170,38,23,gold);
                Label(amounts[i].ToString("N0")+" PAID COINS",x+22,y+54,360,34,21);
                Label("FIRST TOP-UP  /  2× BONUS",x+390,y+18,265,26,14,cyan);
                var select=Button("VIEW",x+488,y+48,194,()=>PurchaseReview(amounts[package].ToString("N0")+" PAID COINS",prices[package],"COIN PACK"),navy);
                select.GetComponent<Image>().color=cyan;
            }
            Label("Paid and free coins are shown separately. Bonus is limited to one first purchase per pack.",64,756,1280,27,15,new Color(.8f,.89f,.95f));
        }
        void DrawCosmetics()
        {
            StoreCosmeticCard("Art/Cosmetics/silk-jacket","CRIMSON SILK JACKET","SSR  ·  COSMETIC","¥480 (proposed)",64,222,"Racewear");
            StoreCosmeticCard("Art/Cosmetics/bridle","BRASS-FIT BRIDLE","SR  ·  COSMETIC","¥320 (proposed)",572,222,"Horse tack");
            StoreCosmeticCard("Art/Cosmetics/saddlecloth","STAR SADDLECLOTH","R  ·  COSMETIC","¥320 (proposed)",1080,222,"Horse tack");
            StoreCosmeticCard("Art/Cosmetics/stable-plaque","STABLE NAMEPLATE","SSR  ·  COSMETIC","¥480 (proposed)",64,474,"Stable decor");
            StoreCosmeticCard("Art/Food/premium-bowl","STAR STABLE BOWL","SSR  ·  DECOR ONLY","¥240 (proposed)",572,474,"Stable decor");
            Label("No random draw. The item and rarity are visible before purchase.",64,744,1180,28,16,new Color(.8f,.89f,.95f));
        }
        void StoreCosmeticCard(string art,string name,string rarity,string price,float x,float y,string kind)
        {
            Panel("Cosmetic "+name,x,y,470,230,new Color(.045f,.12f,.19f,.97f));
            ArtImage(art,x+7,y+13,146,200);
            Label(name,x+164,y+18,292,50,18);
            Label(rarity,x+164,y+68,292,28,14,gold);
            Label(kind+"  /  no ranked stat bonus",x+164,y+99,292,34,13,new Color(.8f,.89f,.95f));
            Label(price,x+164,y+136,292,28,16,cyan);
            Button("REVIEW",x+164,y+166,286,58,()=>PurchaseReview(name,price,"COSMETIC"),navy);
        }
        void DrawCourseProducts()
        {
            CourseProductCard(1,"SPRING MEADOW","SR  ·  COURSE SKIN","¥680 (proposed)",68,222);
            CourseProductCard(2,"AUTUMN GOLD","SSR  ·  COURSE SKIN","¥680 (proposed)",816,222);
            Panel("Weather pack tile",68,555,1430,174,new Color(.045f,.12f,.19f,.97f));
            ArtImage("Art/Weather/rain",82,563,200,156);
            Label("TWILIGHT RAIN ATMOSPHERE",300,576,760,36,21);
            Label("SSR  ·  LIGHTING AND WEATHER EFFECTS ONLY",300,615,760,30,15,gold);
            Label("Visual add-on for private rooms. Ranked weather is fixed by the event.",300,647,770,36,15,new Color(.8f,.89f,.95f));
            Label("¥240 (proposed)",1140,570,300,28,17,gold);
            Button("REVIEW",1130,623,340,()=>PurchaseReview("Twilight rain atmosphere","¥240 (proposed)","COSMETIC"),navy);
        }
        void CourseProductCard(int index,string name,string rarity,string price,float x,float y)
        {
            Panel("Course product "+name,x,y,680,308,new Color(.045f,.12f,.19f,.97f));
            ArtImage(CourseArt(index),x+10,y+10,660,175);
            Label(name,x+22,y+195,400,34,21);
            Label(rarity+"  ·  no gameplay change",x+22,y+232,405,28,15,gold);
            Label(price,x+435,y+220,220,25,16,gold);
            Button("REVIEW",x+435,y+250,220,()=>PurchaseReview(name,price,"COSMETIC"),navy);
        }
        void SeasonPass()
        {
            currentScreen=SeasonPass;Clear();SetArt("Art/home-paddock");
            Panel("Pass frame",36,46,1528,772,navy);
            Label("TURF SERIES  /  SEASON 01",70,68,760,40,24,cyan);
            Panel("Pass hero panel",66,126,405,606,new Color(.04f,.1f,.17f,.96f));
            ArtImage("Art/Cosmetics/jockey-violet",94,138,350,420);
            Label("VIOLET STAR SILKS",90,568,350,34,22,gold);
            Label("Immediate reward with Premium Pass.",90,605,345,46,17);
            Label("FREE + PREMIUM REWARD TRACKS",520,92,850,37,22);
            Label("Earn tiers by racing. No stamina gate.",520,129,850,30,16,new Color(.8f,.89f,.95f));
            string[] free={"100 COINS","R CARE KIT","100 COINS","SADDLE TAG","200 COINS"};
            string[] premium={"SILK SET","SR TICKET","STABLE DECOR","300 COINS","SSR TACK"};
            for(int i=0;i<5;i++)
            {
                float x=520+i*198;
                Panel("Free reward "+i,x,217,180,178,new Color(.055f,.14f,.22f,.97f));
                Label("TIER  "+(i+1),x+14,231,150,28,15,cyan);
                Label(free[i],x+14,281,150,72,19);
                Label("FREE",x+14,357,150,24,14,new Color(.78f,.88f,.94f));
                Panel("Premium reward "+i,x,412,180,178,new Color(.09f,.13f,.22f,.97f));
                Label("TIER  "+(i+1),x+14,426,150,28,15,gold);
                Label(premium[i],x+14,475,150,72,19);
                Label("PREMIUM",x+14,552,150,24,14,gold);
            }
            Panel("Pass price",520,594,980,74,new Color(.04f,.11f,.18f,.97f));
            Label("¥1,000 / 30 days  ·  renews through platform settings",544,609,720,29,19,gold);
            Label("No charge until platform billing and age checks are configured.",544,638,740,24,14,new Color(.8f,.89f,.95f));
            Button("REVIEW PREMIUM PASS",520,683,470,()=>PurchaseReview("TURF SERIES PREMIUM PASS","¥1,000 / 30 days","SEASON PASS"),cyan);
            Button("BACK",70,775,180,Home,navy);
            Button("OPEN STORE",1110,775,350,()=>{storeTab=0;Store();},navy);
        }
        void PurchaseReview(string title,string price,string kind)
        {
            if(!purchaseReviewOpen){purchaseReturnScreen=currentScreen;selectedAgeGroup=-1;}
            purchaseReviewOpen=true;
            pendingPurchaseTitle=title;pendingPurchasePrice=price;pendingPurchaseKind=kind;
            currentScreen=()=>PurchaseReview(pendingPurchaseTitle,pendingPurchasePrice,pendingPurchaseKind);
            Clear();SetArt("Art/home-paddock");Panel("Purchase review veil",0,0,1600,900,new Color(.01f,.035f,.07f,.58f));
            Panel("Purchase review",225,105,1150,690,navy);
            Label("PURCHASE REVIEW  /  AGE AND BILLING CHECK",275,140,950,40,23,cyan);
            Label("Selected item",278,220,220,28,16,new Color(.8f,.89f,.95f));
            Label(title,278,257,735,54,32);
            Label(LocaleService.Text(kind)+"  ·  "+LocaleService.Text(price),278,320,740,36,21,gold);
            Panel("Review divider",278,378,1000,2,new Color(.35f,.55f,.66f));
            Label("Select the age range to design the age-check step.",278,405,900,34,18);
            string[] age={"UNDER 16","16–17","18+"};
            for(int i=0;i<3;i++){int choice=i;var b=Button(age[i],278+i*235,458,210,()=>SelectAgeGroup(choice),selectedAgeGroup==i?cyan:navy);if(selectedAgeGroup==i)b.interactable=false;}
            Label("Age-based monthly limits and guardian consent rules must be supplied by the service.",278,548,960,58,17,new Color(.82f,.9f,.96f));
            Panel("Checkout lock",278,625,995,88,new Color(.16f,.07f,.08f,.95f));
            Label("CHECKOUT DISABLED  /  PLATFORM BILLING NOT CONNECTED",300,640,930,30,18,new Color(1f,.72f,.55f));
            Label("Displayed prices for cosmetics are proposals. No charge is made in this prototype.",300,675,930,28,15,new Color(.9f,.82f,.78f));
            Button("BACK",278,736,290,ReturnFromPurchase,navy);
            Button("CLOSE",1090,736,180,()=>{purchaseReviewOpen=false;Home();},navy);
        }
        void SelectAgeGroup(int choice){selectedAgeGroup=choice;PurchaseReview(pendingPurchaseTitle,pendingPurchasePrice,pendingPurchaseKind);}
        void ReturnFromPurchase(){purchaseReviewOpen=false;if(purchaseReturnScreen!=null)purchaseReturnScreen();else Home();}
        void Info(string title,string body,Action next)
        {
            currentScreen=()=>Info(title,body,next);Clear();SetArt("Art/home-paddock");Panel("Information",300,170,1000,540,navy);Label(title,350,220,900,80,44,cyan);
            Label(body,350,335,900,240,28);Button("CONTINUE  >>",760,610,480,next);
        }
        void Entry()
        {
            currentScreen=Entry;Clear();SetArt(EquippedCourse==0?"Art/first-ride":CourseArt(EquippedCourse));Panel("Race registration",970,67,590,755,navy);
            Label("RANKED RACE  /  ENTRY",1010,105,500,35,17,cyan);
            Label("GREENFIELD CUP",1010,162,500,60,34);
            Label("TURF  ·  2,000 m  ·  LEFT",1010,235,500,36,20,gold);
            Panel("Course map plate",1010,300,500,145,new Color(.05f,.15f,.21f,.9f));
            Label("HOME STRAIGHT  ━━━━━━━  FINISH",1040,350,450,46,20);
            Label("12 runners   /   CPU fills empty gates\nRanked race   /   ability cap enabled\nPartner   /   "+horseName,1010,490,500,130,20);
            var raceButton=Button("ENTER THE RACE  >>",1010,675,495,()=>BeginRace(false));raceButton.GetComponent<Image>().color=cyan;
            Button("BACK",1010,765,160,Home,navy);
        }
        void BeginRace(bool first)
        {
            tutorial=first;race.Reset();BuildRaceScreen();
        }
        void BuildRaceScreen()
        {
            currentScreen=BuildRaceScreen;Clear();world.PlayerPartnerIndex=EquippedPartner;world.StartRace();inRace=true;
            Panel("Distance plate",35,35,360,90,navy);distance=Label("420 m",60,50,320,65,46);
            Panel("Position plate",1280,35,285,100,navy);position=Label("12 / 12",1310,48,250,75,57,gold);
            clock=Label("0:00.0",700,40,300,50,30);
            Panel("Stamina plate",35,680,500,130,navy);stamina=Label("STAMINA",60,700,450,40,23);
            Panel("Stamina track",60,755,440,22,new Color(.2f,.28f,.34f));
            staminaFill=Panel("Stamina fill",60,755,440,22,cyan);
            feedback=Label(tutorial?"TIME YOUR SPUR":"FINAL STRAIGHT",510,220,700,80,40,gold);
            spurs=Label("SPURS  6 / 6",1100,530,460,50,26,gold);
            Button("<",35,530,110,()=>world.MoveLane(-1),navy);Button(">",165,530,110,()=>world.MoveLane(1),navy);
            Button("SPUR",1250,600,290,Spur,gold);
            Label("Hold SPACE to rein / Arrow keys to steer / E to spur",35,820,1050,35,20);
            Button("REIN",325,530,210,()=>{},navy);
            // Pointer hold for touch controls. Keyboard space uses the same state.
            var reinButton=safe.Find("REIN").gameObject;
            var hold=reinButton.AddComponent<HoldControl>();hold.Changed=v=>reinHeld=v;
            Button("EXIT",1400,815,165,Home,navy);
            Panel("Minimap",1180,725,200,85,navy);
            dots=new RectTransform[12];
            for(int i=0;i<12;i++)dots[i]=Panel("Runner "+i,1190,735+i*5,6,6,i==0?gold:Color.white).rectTransform;
        }
        bool reinHeld;
        void Spur()
        {
            if(!race.Spur())return;
            feedback.text=LocaleService.Text(race.LastSpurPerfect?"PERFECT TIMING":"SPUR!");messageUntil=Time.time+1.2f;
        }
        void Update()
        {
            if(safe==null)return;
            if(!inRace){reinHeld=false;return;}
            if(Input.GetKeyDown(KeyCode.LeftArrow))world.MoveLane(-1);
            if(Input.GetKeyDown(KeyCode.RightArrow))world.MoveLane(1);
            if(Input.GetKeyDown(KeyCode.E))Spur();
            race.Step(Time.deltaTime,reinHeld||Input.GetKey(KeyCode.Space));world.Present(race);
            position.text=LocaleService.IsJapanese?race.Place+"位 / 12位":race.Place+" / 12";
            int remaining=Mathf.CeilToInt(RacePresentation.Length-race.Distance[0]);distance.text=LocaleService.IsJapanese?"残り "+remaining+" m":remaining+" m";
            clock.text=race.Time.ToString("00.0")+(LocaleService.IsJapanese?"秒":" s");spurs.text=(LocaleService.IsJapanese?"仕掛け　":"SPURS  ")+race.Spurs+" / 6";
            staminaFill.rectTransform.sizeDelta=new Vector2(440*race.Stamina,22);
            if(Time.time>messageUntil)feedback.text=LocaleService.Text(Mathf.Sin(race.Time*3)>.25f?"SPUR WINDOW":"HOLD YOUR LINE");
            for(int i=0;i<12;i++)dots[i].anchoredPosition=new Vector2(1190+180*race.Distance[i]/RacePresentation.Length,-(735+i*5));
            if(race.Finished)Result();
        }
        void Result()
        {
            currentScreen=Result;
            bool first=tutorial;int place=race.Place;float time=race.Time;
            Clear();SetArt("Art/race-result");Panel("Result detail",42,55,620,780,navy);
            Label("RACE RESULT  /  GREENFIELD CUP",80,99,540,34,17,cyan);
            Label(LocaleService.IsJapanese?place+"位":place==1?"1ST":place+"TH",80,166,540,130,89,gold);
            Label(place==1?"VICTORY":"RACE COMPLETE",80,300,540,60,33);
            Label(horseName+"  /  TURF 2,000 m",80,377,520,35,18);
            Panel("Result rule",80,440,500,2,new Color(.45f,.62f,.71f));
            Label("TIME",80,482,120,30,16,cyan);Label(time.ToString("0.0")+" s",80,520,230,45,31);
            Label("RANK POINTS",340,482,210,30,16,cyan);Label(place==1?"+120 pt":"+40 pt",340,520,230,45,31,gold);
            Label(first?"Your first race is complete.":"A new race is waiting.",80,607,500,38,17);
            var next=Button(first?"MEET YOUR PARTNER":"CONTINUE  >>",80,675,500,first?(Action)NamePartner:Home);next.GetComponent<Image>().color=cyan;
            Label("LOCAL PRESENTATION PREVIEW",80,780,500,26,13,new Color(.72f,.83f,.91f));
        }
        void OnApplicationFocus(bool focused){if(!focused)reinHeld=false;}
        void OnDestroy(){if(world!=null)Destroy(world.gameObject);if(canvas!=null)Destroy(canvas.gameObject);}
    }
}
