package io.rovara.fixture;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The fixture app of the device-executor CI test. Four rows of 200 pixels on a light page: a headline (the one thing that differs between the "before" and the "after" build), a line with an email
 * address in it (the mask must paint it), a password field (always painted) and a button that changes the headline (the Maestro step taps it).
 */
public class MainActivity extends Activity {
  /** Replaced by build.sh: one text for the base build, another for the candidate. */
  private static final String HEADLINE = "@HEADLINE@";

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
    LinearLayout page = new LinearLayout(this);
    page.setOrientation(LinearLayout.VERTICAL);
    page.setBackgroundColor(Color.rgb(238, 238, 238));

    final TextView headline = new TextView(this);
    headline.setText(HEADLINE);
    headline.setTextSize(28);
    headline.setTextColor(Color.BLACK);
    page.addView(headline, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 200));

    TextView contact = new TextView(this);
    contact.setText("Contact: sam@example.org");
    contact.setTextSize(20);
    contact.setTextColor(Color.BLACK);
    page.addView(contact, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 200));

    EditText secret = new EditText(this);
    secret.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    secret.setText("hunter2");
    page.addView(secret, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 200));

    Button next = new Button(this);
    next.setText("Continue");
    next.setOnClickListener(new View.OnClickListener() {
      @Override
      public void onClick(View view) {
        headline.setText("Step two");
      }
    });
    page.addView(next, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 200));

    setContentView(page);
  }
}
