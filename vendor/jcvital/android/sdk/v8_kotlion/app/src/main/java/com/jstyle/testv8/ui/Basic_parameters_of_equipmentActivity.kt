package com.jstyle.testv8.ui

import android.os.Bundle
import android.util.Log
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.R
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityBaseBinding

/**
 *
 */
lateinit var activityBase: ActivityBaseBinding

class Basic_parameters_of_equipmentActivity : BaseActivity() {
    var Is_the_sports_mode_flashing: Boolean = true
    var Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode: Boolean = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityBase=ActivityBaseBinding.inflate(layoutInflater)
        setContentView(activityBase.getRoot());


    }
    override fun init() {
        activityBase.radioGroupMian .check(R.id.radio_yes)
        activityBase.  radioGroupMian2.check(R.id.radio_yes2)

        activityBase. radioGroupMian.setOnCheckedChangeListener { group, checkedId ->
            when (checkedId) {
                R.id.radio_yes -> Is_the_sports_mode_flashing = true
                R.id.radio_no -> Is_the_sports_mode_flashing = false
            }
        }
        activityBase.  radioGroupMian2.setOnCheckedChangeListener({ group, checkedId ->
            when (checkedId) {
                R.id.radio_yes2 -> Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode =
                    true

                R.id.radio_no2 -> Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode =
                    false
            }
        })

        activityBase.set.setOnClickListener {
            sendValue(
                BleSDK.SetBasic_parameters_of_equipment(
                    Is_the_sports_mode_flashing,
                    Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode
                ))
        }
        activityBase.get.setOnClickListener {
            sendValue(BleSDK.GetBasic_parameters_of_equipment())
        }
    }



    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        Log.e("dataCallback", maps.toString())
        when (dataType) {
            BleConst.SetBasic_parameters_of_equipment, BleConst.GetBasic_parameters_of_equipment -> if (null != activityBase.info) {
                activityBase.info.text = maps.toString()
            }
        }
    }


}
