package com.jstyle.blesdkv8.callback;


import com.jstyle.blesdkv8.model.Device;

public interface OnScanResults {
  void Success(Device date);
  void Fail(int code);
}
