package com.jstyle.testv8.ble.ota;

/**
 * The factory should be used to create the {@link BLEScanner} instance appropriate
 * for the Android version.
 */
public class BLEScannerFactory {

	/**
	 * Returns the scanner implementation.
	 *
	 * @return the bootloader scanner
	 */
	public static BLEScanner getScanner() {
			return new BLEScannerLollipop();
	}
}
