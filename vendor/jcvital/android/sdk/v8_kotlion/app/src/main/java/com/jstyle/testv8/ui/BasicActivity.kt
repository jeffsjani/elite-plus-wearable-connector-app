package com.jstyle.testv8.ui


import android.os.Bundle
import android.text.TextUtils
import com.jstyle.testv8.R
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityBasicBinding
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.MyPersonalInfo


lateinit var activityBasicBinding: ActivityBasicBinding

class BasicActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityBasicBinding = ActivityBasicBinding.inflate(layoutInflater);
        setContentView(activityBasicBinding.getRoot());

    }
    override fun init() {
        activityBasicBinding.buttonSetinfo.setOnClickListener {
            setUserInfo()//设置用户信息到设备 Set user information to device
        }
        activityBasicBinding.buttonGetinfo.setOnClickListener {
            sendValue(BleSDK.GetPersonalInfo())//从设备读取用户个人信息 Read user's personal information from the device
        }
    }


    private fun setUserInfo() {
        if (TextUtils.isEmpty(activityBasicBinding.editTextAge.getText().toString()) ||
            TextUtils.isEmpty(activityBasicBinding.editTextHeight.getText().toString()) ||
            TextUtils.isEmpty(activityBasicBinding.editTextWeight.getText().toString()) ||
            TextUtils.isEmpty(activityBasicBinding.editTextStride.getText().toString())
        ) return
        val age = Integer.valueOf(activityBasicBinding.editTextAge.getText().toString())
        val height = Integer.valueOf(activityBasicBinding.editTextHeight.getText().toString())
        val weight = Integer.valueOf(activityBasicBinding.editTextWeight.getText().toString())
        val stepLength = Integer.valueOf(activityBasicBinding.editTextStride.getText().toString())
        val gender = if (activityBasicBinding.radioGroupGender.getCheckedRadioButtonId() ==R.id.radio_male) 1 else 0
        val setPersonalInfo = MyPersonalInfo()
        setPersonalInfo.setAge(age) //年龄 Age
        setPersonalInfo.setHeight(height) //身高 height
        setPersonalInfo.setWeight(weight) //体重 weight
        setPersonalInfo.setStepLength(stepLength) //步长  step length
        setPersonalInfo.setSex(gender) //性别 Gender  1 male,0female
        sendValue(BleSDK.SetPersonalInfo(setPersonalInfo)) //设置用户信息到设备 Set user information to device
    }



     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val data = getData(maps)
        when (dataType) {
            BleConst.SetPersonalInfo -> if (null != activityBasicBinding.info) {
                activityBasicBinding.info.setText(maps.toString())
            }

            BleConst.GetPersonalInfo -> {
                val age = data!!.get(DeviceKey.Age)
                val height = data.get(DeviceKey.Height)
                val weight = data.get(DeviceKey.Weight)
                val stepLength = data.get(DeviceKey.Stride)
                val gender = data.get(DeviceKey.Gender)!!
                activityBasicBinding.editTextStride.setText(stepLength.toString())
                activityBasicBinding.editTextHeight.setText(height.toString())
                activityBasicBinding.editTextWeight.setText(weight.toString())
                activityBasicBinding.editTextAge.setText(age.toString())
                activityBasicBinding.radioGroupGender.check(if (gender == 1) R.id.radio_male else R.id.radio_female)
            }
        }
    }

}
