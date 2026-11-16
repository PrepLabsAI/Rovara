import UIKit

// The fixture app of the macOS device test (device testing slice 4). Four rows of 60 points on a light page: a headline (the one thing that differs between the base and the candidate build: build.sh
// writes it in place of @HEADLINE@), a line with an email address in it (the mask must paint it), a password field (always painted) and a button that changes the headline (the Maestro step taps it).
final class FixtureViewController: UIViewController {
  private let headline = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 238 / 255, green: 238 / 255, blue: 238 / 255, alpha: 1)
    headline.text = "@HEADLINE@"
    headline.font = UIFont.systemFont(ofSize: 28)
    headline.textColor = .black
    headline.accessibilityIdentifier = "headline"

    let contact = UILabel()
    contact.text = "Contact: sam@example.org"
    contact.font = UIFont.systemFont(ofSize: 20)
    contact.textColor = .black

    let secret = UITextField()
    secret.isSecureTextEntry = true
    secret.text = "hunter2"
    secret.placeholder = "Password"
    secret.borderStyle = .roundedRect

    let next = UIButton(type: .system)
    next.setTitle("Continue", for: .normal)
    next.addTarget(self, action: #selector(tapped), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [headline, contact, secret, next])
    stack.axis = .vertical
    stack.distribution = .fillEqually
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 40),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      stack.heightAnchor.constraint(equalToConstant: 240),
    ])
  }

  @objc private func tapped() { headline.text = "Step two" }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = FixtureViewController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
