using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
namespace Muchi.Client.Editor
{
    public static class ProjectSetup
    {
        [MenuItem("Muchi/Create Frontend Scene")]
        public static void CreateScene()
        {
            if(!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())return;
            var scene=EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            new GameObject("Muchi Frontend").AddComponent<MuchiApp>();
            System.IO.Directory.CreateDirectory("Assets/Muchi/Scenes");
            EditorSceneManager.SaveScene(scene,"Assets/Muchi/Scenes/Frontend.unity");
            EditorBuildSettings.scenes=new[]{new EditorBuildSettingsScene("Assets/Muchi/Scenes/Frontend.unity",true)};
            PlayerSettings.defaultInterfaceOrientation=UIOrientation.LandscapeLeft;
            PlayerSettings.companyName="Muchi";PlayerSettings.productName="Muchi Issen";
            PlayerSettings.defaultScreenWidth=1600;PlayerSettings.defaultScreenHeight=900;
            Selection.activeGameObject=Object.FindObjectOfType<MuchiApp>().gameObject;
        }
    }
}
