using System;
using UnityEngine;
using UnityEngine.EventSystems;
namespace Muchi.Client
{
    public sealed class HoldControl : MonoBehaviour, IPointerDownHandler, IPointerUpHandler, IPointerExitHandler
    {
        public Action<bool> Changed;
        public void OnPointerDown(PointerEventData e){Changed?.Invoke(true);}
        public void OnPointerUp(PointerEventData e){Changed?.Invoke(false);}
        public void OnPointerExit(PointerEventData e){Changed?.Invoke(false);}
        void OnDisable(){Changed?.Invoke(false);}
    }
}
