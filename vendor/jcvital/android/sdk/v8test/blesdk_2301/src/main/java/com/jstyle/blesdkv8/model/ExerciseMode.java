package com.jstyle.blesdkv8.model;

/**
 * Created by Administrator on 2018/8/2.
 */

public class ExerciseMode extends SendData {
    public static final int Status_START=1;
    public static final int Status_PAUSE=2;
    public static final int Status_CONTUINE=3;
    public static final int Status_FINISH=4;

    public static final int Mode_RUN=0;
    public static final int Mode_CYCLING=1;
    public static final int Mode_Badminton=2;
    public static final int Mode_Football=3;
    public static final int Mode_Tennis=4;
    public static final int Mode_Yoga=5;
    public static final int Mode_Breathing_Training=6;
    public static final int Mode_Dancing=7;
    public static final int Mode_Basketball=8;
    public static final int Mode_Walking=9;
    public static final int Mode_Workout=10;
    public static final int Mode_Cricket=11;
    public static final int Mode_Hiking=12;
    public static final int Mode_Aerobics=13;
    public static final int Mode_Ping_Pong=14;

  /*  public static final int Mode_RUN=0;
    public static final int Mode_CYCLING=1;
    public static final int Mode_Walking=2;
    public static final int Mode_Badminton=3;
    public static final int Mode_Football=4;
    public static final int Mode_Tennis=5;
    public static final int Mode_Breathing_Training=6;
    public static final int Mode_Dancing=7;
    public static final int Mode_Basketball=8;
    public static final int Mode_Weightlifting=9;
    public static final int Mode_Cricket=10;
    public static final int Mode_Hiking=11;
    public static final int Mode_Aerobics=12;
    public static final int Mode_Table_Tennis=13;
    public static final int Mode_Jump_Rope=14;
    public static final int Mode_Sit_ups=15;
    public static final int Mode_Volleyball=16;
    public static final int Mode_Handball=17;
    public static final int Mode_Baseball=18;
    public static final int Mode_Field_Hockey=19;
    public static final int Mode_Fencing=20;
    public static final int Mode_Boxing=21;
    public static final int Mode_Mixed_Martial_Arts=22;
    public static final int Mode_Wrestling=23;
    public static final int Mode_Javelin_Throw=24;
    public static final int Mode_Pole_Vault=25;
    public static final int Mode_High_Jump=26;
    public static final int Mode_Double_Rowing=27;
    public static final int Mode_Sailing=28;
    public static final int Mode_Rowing=29;
    public static final int Mode_Balance_Beam=30;
    public static final int Mode_Artistic_Gymnastics=31;
    public static final int Mode_Long_Jump=32;
    public static final int Mode_Shot_Put=33;
    public static final int Mode_Hammer_Throw=34;
    public static final int Mode_Trampoline=35;
    public static final int Mode_Rings=36;
    public static final int Mode_Pommel_Horse=37;
    public static final int Mode_Horizontal_Bar=38;
    public static final int Mode_Triathlon=39;
    public static final int Mode_Bowling=40;
    public static final int Mode_Skiing=40;
    public static final int Mode_Ice_Skating=42;
    public static final int Mode_Treadmill=43;
    public static final int Mode_Spinning=44;*/


    /*public static int[]modes=new int[]{Mode_RUN,Mode_CYCLING,
   Mode_Walking,
  Mode_Badminton,
   Mode_Football,
    Mode_Tennis,
   Mode_Breathing_Training,
   Mode_Dancing,
   Mode_Basketball,
    Mode_Weightlifting,
   Mode_Cricket,
  Mode_Hiking,
   Mode_Aerobics,
    Mode_Table_Tennis,
   Mode_Jump_Rope,
    Mode_Sit_ups,
    Mode_Volleyball,
   Mode_Handball,
   Mode_Baseball,
   Mode_Field_Hockey,
   Mode_Fencing,
    Mode_Boxing,
   Mode_Mixed_Martial_Arts,
   Mode_Wrestling,
    Mode_Javelin_Throw,
     Mode_Pole_Vault,
    Mode_High_Jump,
    Mode_Double_Rowing,
     Mode_Sailing,
     Mode_Rowing,
    Mode_Balance_Beam,
   Mode_Artistic_Gymnastics,
     Mode_Long_Jump,
    Mode_Shot_Put,
   Mode_Hammer_Throw,
     Mode_Trampoline,
   Mode_Rings,
    Mode_Pommel_Horse,
    Mode_Horizontal_Bar,
    Mode_Triathlon,
    Mode_Bowling,
   Mode_Skiing,
   Mode_Ice_Skating,
    Mode_Treadmill,
    Mode_Spinning};*/

    public static int[]modes=new int[]{
            Mode_RUN,
            Mode_CYCLING,
            Mode_Badminton,
            Mode_Football,
            Mode_Tennis,
            Mode_Yoga,
            Mode_Breathing_Training,
            Mode_Dancing,
            Mode_Basketball,
            Mode_Walking,
            Mode_Workout,
            Mode_Cricket,
            Mode_Hiking,
            Mode_Aerobics,
            Mode_Ping_Pong};
    int exerciseMode;
    int enableStatus;
    public int getExerciseMode(int position){
        return modes[position];
    }
    public int getExerciseMode() {
        return exerciseMode;
    }

    public void setExerciseMode(int exerciseMode) {
        this.exerciseMode = exerciseMode;
    }

    public int getEnableStatus() {
        return enableStatus;
    }

    public void setEnableStatus(int enableStatus) {
        this.enableStatus = enableStatus;
    }
}
