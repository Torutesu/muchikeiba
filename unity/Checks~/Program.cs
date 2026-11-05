using System;
using Muchi.Client;
namespace UnityEngine { public static class Mathf {
 public static float Sin(float x)=>(float)Math.Sin(x);
 public static float Min(float a,float b)=>Math.Min(a,b);
 public static float Max(float a,float b)=>Math.Max(a,b);
 public static float Clamp01(float x)=>Math.Clamp(x,0,1);
 public static float MoveTowards(float a,float b,float d)=>a<b?Math.Min(a+d,b):Math.Max(a-d,b);
}}
class Check {
 static void Assert(bool ok,string message){if(!ok)throw new Exception(message);}
 static void Main(){
 var r=new RacePresentation();r.Reset();Assert(r.Spurs==6&&r.Stamina==1,"reset");
 Assert(r.Spur(),"first spur");Assert(!r.Spur(),"cooldown");
 for(int i=0;i<9000&&!r.Finished;i++){r.Step(1f/60,false);if(i%70==0)r.Spur();Assert(r.Stamina>=0&&r.Stamina<=1,"stamina bounds");}
 Assert(r.Finished&&r.Place>=1&&r.Place<=12,"completion");Assert(r.Spurs==0,"six spurs");Assert(!r.Spur(),"no action after finish");
 var slow=new RacePresentation();slow.Reset();for(int i=0;i<9000&&!slow.Finished;i++)slow.Step(1f/60,true);
 Assert(slow.Finished&&slow.Place==12,"finish order preserves earlier CPU finishers");
 r.Reset();Assert(!r.Finished&&r.Time==0&&r.Spurs==6,"replay reset");
 Console.WriteLine("PASS: cooldown, stamina, spur limit, finish order, completion, replay reset");
 }}
